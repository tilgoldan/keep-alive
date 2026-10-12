import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import trayWhite1x from "./assets/icons/tray-white.png";
import trayWhite2x from "./assets/icons/tray-white@2x.png";
import trayBlack1x from "./assets/icons/tray-black.png";
import trayBlack2x from "./assets/icons/tray-black@2x.png";

/*
 * Keep Alive — keep Obsidian running in the background instead of quitting, with an optional tray icon.
 * Single purpose by design. Design notes live in the project docs (00. OVERVIEW / 01. Spec).
 */

// Menu bar / tray icons (assets/icons/, inlined as base64 by the build): black and white
// silhouettes on transparent, each as a 13x16 px 1x and a 26x32 px 2x image. Electron's
// scale-factor options misreport sizes here, so the pair is written next to each other as
// "name.png" + "name@2x.png" and the 1x file is loaded by path: Electron then attaches both and
// macOS uses the 2x one on Retina displays.
// The colour is picked from the system appearance (see resolveTrayIcon).
const TRAY_ICONS = {
	white: { x1: trayWhite1x, x2: trayWhite2x },
	black: { x1: trayBlack1x, x2: trayBlack2x },
};

// ── Minimal types for the Electron main-process API reached from the renderer ──
// Declaring only the members we actually use keeps the unsafe-access lint rules quiet.
interface ElectronEvent {
	preventDefault(): void;
	returnValue?: boolean;
}

type ElectronListener = (...args: never[]) => void;

interface NativeImageLike {
	isEmpty(): boolean;
}

interface ElectronWindow {
	id: number;
	hide(): void;
	show(): void;
	showInactive(): void;
	focus(): void;
	restore(): void;
	close(): void;
	destroy(): void;
	isVisible(): boolean;
	isMinimized(): boolean;
	isDestroyed(): boolean;
	isResizable(): boolean;
	setSkipTaskbar(skip: boolean): void;
	on(event: "close", listener: (e: ElectronEvent) => void): void;
	on(event: "ready-to-show" | "show", listener: () => void): void;
	removeListener(event: "close", listener: ElectronListener): void;
}

interface ElectronTray {
	setToolTip(tooltip: string): void;
	setContextMenu(menu: unknown): void;
	popUpContextMenu(menu?: unknown): void;
	on(event: "click" | "right-click", listener: () => void): void;
	destroy(): void;
}

interface MenuItemTemplate {
	label?: string;
	type?: string;
	enabled?: boolean;
	click?: () => void;
}

interface ElectronApp {
	prependListener(event: "second-instance", listener: () => void): void;
	on(
		event: "browser-window-created",
		listener: (e: ElectronEvent, w: ElectronWindow) => void
	): void;
	on(event: "before-quit", listener: () => void): void;
	on(event: "activate", listener: () => void): void;
	removeListener(event: string, listener: ElectronListener): void;
	emit(event: string): boolean;
	quit(): void;
	relaunch(): void;
	exit(code: number): void;
	dock?: { show?: () => unknown; hide?: () => void };
	focus?(options?: { steal?: boolean }): void;
}

interface ElectronRemote {
	app: ElectronApp;
	getCurrentWindow(): ElectronWindow;
	BrowserWindow?: { getAllWindows(): ElectronWindow[] };
	Tray: new (icon: NativeImageLike) => ElectronTray;
	nativeTheme?: { shouldUseDarkColors: boolean };
	systemPreferences?: {
		getUserDefault(key: string, type: "string"): string;
		subscribeNotification(
			event: string,
			callback: () => void
		): number;
		unsubscribeNotification(id: number): void;
	};
	Menu: { buildFromTemplate(template: MenuItemTemplate[]): unknown };
	nativeImage: {
		createFromPath(path: string): NativeImageLike;
		createFromDataURL(dataUrl: string): NativeImageLike;
	};
}

interface BackgroundTraySettings {
	createTrayIcon: boolean;
	focusOnRelaunch: boolean;
	trayIconPath: string;
	trayTooltip: string;
	hideDockWhenHidden: boolean;
	trayIconColor: "auto" | "white" | "black";
}

const DEFAULT_SETTINGS: BackgroundTraySettings = {
	createTrayIcon: true,
	focusOnRelaunch: true,
	trayIconPath: "",
	trayTooltip: "{{vault}} — Obsidian",
	hideDockWhenHidden: false,
	trayIconColor: "auto",
};

// Reach the Electron main-process module from the renderer. The path differs between builds,
// so fall back; going through window.require avoids the static-import lint rules.
function getRemote(): ElectronRemote | null {
	if (typeof window === "undefined") return null;
	const electronRequire = (
		window as unknown as { require?: (id: string) => unknown }
	).require;
	if (typeof electronRequire !== "function") return null;
	try {
		return electronRequire("@electron/remote") as ElectronRemote;
	} catch {
		/* @electron/remote unavailable → try the legacy path */
	}
	try {
		const legacy = electronRequire("electron") as {
			remote?: ElectronRemote;
		};
		return legacy.remote ?? null;
	} catch {
		/* Electron is not reachable */
	}
	return null;
}

export default class BackgroundTrayPlugin extends Plugin {
	settings!: BackgroundTraySettings;

	private remote: ElectronRemote | null = null;
	private win: ElectronWindow | null = null;
	private tray: ElectronTray | null = null;
	private appearanceSubId: number | null = null;
	// The tray's right-click menu. On macOS it is popped up by hand (see createTray), because
	// setContextMenu would make a plain left click open the menu as well.
	private trayMenu: unknown = null;
	private closeHandler: ((e: ElectronEvent) => void) | null = null;
	private beforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;
	private secondInstanceHandler: (() => void) | null = null;
	private windowCreatedHandler:
		| ((event: ElectronEvent, w: ElectronWindow) => void)
		| null = null;
	private lastRelaunchAt = 0;
	private reallyQuitting = false;
	// macOS: app-level listeners (Cmd+Q / dock Quit / shutdown, and dock-icon click).
	private beforeQuitHandler: (() => void) | null = null;
	private activateHandler: (() => void) | null = null;
	private beforeQuitResetTimer: ReturnType<typeof setTimeout> | null = null;
	// Vault pickers we hid on relaunch (never closed, see registerSingleInstance). They must go
	// away before the main window does, or Obsidian never reaches window-all-closed (issue #3).
	private hiddenPickers: ElectronWindow[] = [];
	// Secondary windows of this vault (pop-out tabs, the Settings window) that we hid together
	// with the main window, to bring back on show (issue #3 follow-up).
	private hiddenSecondaries: ElectronWindow[] = [];
	// DOM windows opened from this vault via window.open — that is how Obsidian creates every
	// pop-out and the Settings window. Tracked so hide/show can treat the vault as one unit.
	private openedWindows = new Set<Window>();
	private originalWindowOpen: typeof window.open | null = null;
	private windowOpenWrapper: typeof window.open | null = null;

	async onload() {
		await this.loadSettings();

		this.remote = getRemote();
		if (!this.remote) {
			new Notice(
				"Keep Alive: cannot reach Electron — the tray is unavailable in this build."
			);
			// Never crash the app: expose the settings tab only, with the features off.
			this.addSettingTab(new BackgroundTraySettingTab(this.app, this));
			return;
		}

		try {
			this.win = this.remote.getCurrentWindow();
		} catch (e) {
			console.error("Keep Alive: getCurrentWindow failed", e);
			this.win = null;
		}

		// ★ Closing is intercepted at two layers:
		//   (1) beforeunload (a renderer event) — the primary veto, reliable on Electron 39.
		//   (2) window.on("close") (remote) — a fallback. On Electron 39 with @electron/remote
		//       preventDefault is ignored (measured; 01. Spec §3.1/§3.3), so beforeunload does the work.
		this.registerBeforeUnload();
		this.registerCloseInterception();
		// Restore the existing window when relaunched while hidden (and suppress the vault picker).
		this.registerSingleInstance();
		// macOS: let Cmd+Q / dock Quit / shutdown through, and reopen on a dock-icon click.
		this.registerMacLifecycle();
		// Know about the pop-out / Settings windows this vault opens, so hiding hides them too.
		this.patchWindowOpen();

		if (this.settings.createTrayIcon) await this.createTray();

		// In some environments app.vault.getName() is still empty during onload → resolve the vault
		// name again once the layout is ready and re-apply the tray labels.
		this.app.workspace?.onLayoutReady?.(() => this.refreshTrayLabels());

		this.addCommand({
			id: "toggle-window",
			name: "Show / Hide window",
			callback: () => this.toggleWindow(),
		});
		this.addCommand({
			id: "show-window",
			name: "Show window",
			callback: () => this.showWindow(),
		});
		this.addCommand({
			id: "hide-window",
			name: "Hide window",
			callback: () => this.hideWindow(),
		});

		this.addSettingTab(new BackgroundTraySettingTab(this.app, this));
	}

	onunload() {
		// Cleanup checklist from 01. Spec §3.4 — turning the plugin off restores everything.
		this.removeBeforeUnload();
		this.removeCloseInterception();
		this.removeSingleInstance();
		this.removeMacLifecycle();
		this.unpatchWindowOpen();
		this.destroyHiddenPickers();
		// Never leave a pop-out invisible with no way to get it back.
		this.restoreSecondaries();
		this.destroyTray();
		try {
			this.win?.setSkipTaskbar(false);
		} catch {
			/* window unreachable */
		}
		try {
			// (macOS) restore the dock icon
			this.remote?.app?.dock?.show?.();
		} catch {
			/* no dock */
		}
		this.win = null;
		this.remote = null;
	}

	// ── Close interception ① beforeunload (primary path) ─────────────────
	// A renderer-native event, so the close can be cancelled synchronously with no remote round trip.
	private registerBeforeUnload() {
		if (typeof window === "undefined") return;
		this.removeBeforeUnload(); // guard against duplicate registration
		this.beforeUnloadHandler = (e: BeforeUnloadEvent) => {
			if (!this.reallyQuitting) {
				e.preventDefault();
				// Electron: cancel the close (returnValue is a deprecated type → cast around it)
				(e as { returnValue: boolean }).returnValue = false;
				// ★ Stop Obsidian's own quit hook (window.onbeforeunload) from running: it treats
				// any close of the main window as a quit, fires workspace "quit" and CLOSES every
				// pop-out and the Settings window — which is why they never came back after a hide.
				// We are hiding, not quitting; that hook still runs on a real quit (reallyQuitting).
				e.stopImmediatePropagation();
				this.hideWindow(); // hide to the tray
			}
		};
		// capture: fires before Obsidian's (bubble-phase) onbeforeunload, so the veto above wins.
		window.addEventListener("beforeunload", this.beforeUnloadHandler, {
			capture: true,
		});
	}

	private removeBeforeUnload() {
		if (typeof window !== "undefined" && this.beforeUnloadHandler) {
			window.removeEventListener(
				"beforeunload",
				this.beforeUnloadHandler,
				{ capture: true }
			);
		}
		this.beforeUnloadHandler = null;
	}

	// ── Secondary windows (pop-outs, Settings) ──────────────────────
	// Obsidian opens every pop-out tab and the Settings window through window.open(). Wrapping
	// it lets hide/show treat the whole vault as one unit. Restored on unload.
	private patchWindowOpen() {
		if (typeof window === "undefined" || this.windowOpenWrapper) return;
		const original = window.open;
		if (typeof original !== "function") return;
		const opened = this.openedWindows;
		const wrapper = function (
			this: unknown,
			...args: Parameters<typeof window.open>
		): ReturnType<typeof window.open> {
			const w = original.apply(window, args);
			if (w) opened.add(w);
			return w;
		};
		this.originalWindowOpen = original;
		this.windowOpenWrapper = wrapper;
		window.open = wrapper;
	}

	private unpatchWindowOpen() {
		if (typeof window !== "undefined" && this.windowOpenWrapper) {
			// Only put the original back if nobody wrapped window.open after us.
			if (window.open === this.windowOpenWrapper && this.originalWindowOpen)
				window.open = this.originalWindowOpen;
		}
		this.windowOpenWrapper = null;
		this.originalWindowOpen = null;
		this.openedWindows.clear();
	}

	// The BrowserWindow behind a DOM window: Obsidian sets `electronWindow` on each of its
	// windows; fall back to that window's own @electron/remote.
	private electronWindowOf(w: Window): ElectronWindow | null {
		try {
			const tagged = (w as unknown as { electronWindow?: ElectronWindow })
				.electronWindow;
			if (tagged) return tagged;
		} catch {
			/* cross-window access failed */
		}
		try {
			const req = (w as unknown as { require?: (id: string) => unknown })
				.require;
			if (typeof req === "function") {
				const r = req("@electron/remote") as ElectronRemote;
				return r.getCurrentWindow();
			}
		} catch {
			/* no remote in that window */
		}
		return null;
	}

	// Every live secondary window of this vault: what we saw window.open() create, plus what
	// Obsidian already had (pop-outs restored with the layout, the Settings window) in case the
	// plugin was enabled after they were opened. Never another vault's windows.
	private collectSecondaryWindows(): ElectronWindow[] {
		const doms = new Set<Window>();
		for (const w of this.openedWindows) {
			let closed = true;
			try {
				closed = w.closed;
			} catch {
				/* unreachable → drop it */
			}
			if (closed) this.openedWindows.delete(w);
			else doms.add(w);
		}
		try {
			const ws = this.app.workspace as unknown as {
				floatingSplit?: { children?: { win?: Window }[] };
			};
			for (const child of ws.floatingSplit?.children ?? []) {
				if (child?.win && !child.win.closed) doms.add(child.win);
			}
		} catch {
			/* private API changed → rely on tracking */
		}
		try {
			const setting = (
				this.app as unknown as {
					setting?: { popout?: { win?: Window } | null };
				}
			).setting;
			const w = setting?.popout?.win;
			if (w && !w.closed) doms.add(w);
		} catch {
			/* private API changed → rely on tracking */
		}

		let myId = -1;
		try {
			myId = this.win?.id ?? -1;
		} catch {
			/* id unreachable */
		}
		const out: ElectronWindow[] = [];
		const seen = new Set<number>();
		for (const d of doms) {
			const bw = this.electronWindowOf(d);
			if (!bw) continue;
			try {
				if (bw.isDestroyed()) continue;
				const id = bw.id;
				if (id === myId || seen.has(id)) continue;
				seen.add(id);
				out.push(bw);
			} catch {
				/* window gone */
			}
		}
		return out;
	}

	// Hide the visible secondary windows and remember them for showWindow().
	private hideSecondaries() {
		for (const bw of this.collectSecondaryWindows()) {
			try {
				if (!bw.isVisible()) continue;
				bw.hide();
				this.hiddenSecondaries.push(bw);
			} catch {
				/* window gone */
			}
		}
	}

	// Bring back what hideSecondaries() hid. Without focus: the main window is focused last.
	private restoreSecondaries() {
		const list = this.hiddenSecondaries;
		this.hiddenSecondaries = [];
		for (const bw of list) {
			try {
				if (bw.isDestroyed()) continue;
				if (typeof bw.showInactive === "function") bw.showInactive();
				else bw.show();
			} catch {
				/* window gone */
			}
		}
	}

	// ── Close interception ② window.on("close") (fallback) ───────────────
	private registerCloseInterception() {
		const win = this.win;
		if (!win) return;
		this.removeCloseInterception(); // guard against duplicate registration
		this.closeHandler = (e: ElectronEvent) => {
			if (!this.reallyQuitting) {
				e.preventDefault();
				this.hideWindow();
				return;
			}
			// The window is really going away: a hidden picker left behind would keep the
			// process alive with no window and no tray.
			this.destroyHiddenPickers();
		};
		try {
			win.on("close", this.closeHandler);
		} catch (e) {
			console.error("Keep Alive: failed to register the close listener", e);
			this.closeHandler = null;
		}
	}

	private removeCloseInterception() {
		if (this.win && this.closeHandler) {
			try {
				this.win.removeListener("close", this.closeHandler);
			} catch {
				/* already removed */
			}
		}
		this.closeHandler = null;
	}

	// ── Single-instance focus ─────────────────────────────
	// Relaunching Obsidian while it is hidden in the tray makes Obsidian open a fresh vault
	// picker from second-instance (measured). We restore the existing window instead and
	// neutralise that picker, so it behaves like "bring the existing window back". (Spec §4.6)
	private registerSingleInstance() {
		const remote = this.remote;
		const win = this.win;
		if (!remote || !win) return;
		const app = remote.app;
		if (typeof app.prependListener !== "function") return;
		this.removeSingleInstance(); // guard against duplicate registration

		let myId = -1;
		try {
			myId = win.id;
		} catch {
			/* id unreachable */
		}

		this.secondInstanceHandler = () => {
			if (!this.settings.focusOnRelaunch) return;
			this.lastRelaunchAt = Date.now();
			this.showWindow();
		};
		this.windowCreatedHandler = (
			_event: ElectronEvent,
			w: ElectronWindow
		) => {
			if (!this.settings.focusOnRelaunch) return;
			let id = -1;
			try {
				id = w.id;
			} catch {
				/* id unreachable */
			}
			if (id === myId) return; // never touch our own window
			// A window created right after second-instance (a short window) = the vault picker.
			if (
				this.lastRelaunchAt > 0 &&
				Date.now() - this.lastRelaunchAt < 4000
			) {
				// Obsidian builds the picker with resizable:false; vault windows and pop-outs are
				// resizable. A relaunch via an obsidian:// link can open another vault in that same
				// window of time — leave anything resizable alone.
				let resizable = true;
				try {
					resizable = w.isResizable();
				} catch {
					/* unknown → treat as a vault window */
				}
				if (resizable) return;
				// ★ Avoids both the flicker and the quit regression:
				//   - Hide the picker every time it tries to appear (ready-to-show/show) so it never paints.
				//   - Never close it. On Obsidian 1.12 / Electron 39, closing the picker can trigger the
				//     window-all-closed quit path even when a hidden main window exists.
				//   - Drop it from the taskbar instead and bring only the existing window forward.
				const hidePicker = () => {
					try {
						if (!w.isDestroyed()) w.hide();
					} catch {
						/* ignore hide failure */
					}
					try {
						if (!w.isDestroyed()) w.setSkipTaskbar(true);
					} catch {
						/* unsupported on some platforms/windows */
					}
				};
				try {
					w.on("ready-to-show", hidePicker);
				} catch {
					/* event unsupported */
				}
				try {
					w.on("show", hidePicker);
				} catch {
					/* event unsupported */
				}
				this.hiddenPickers.push(w);
				window.setTimeout(hidePicker, 0);
				window.setTimeout(() => {
					try {
						const win = this.win;
						if (!this.remote || !win || win.isDestroyed()) return;
						hidePicker();
						this.showWindow();
					} catch {
						/* ignore restore failure */
					}
				}, 150);
			}
		};
		try {
			// prepend so the existing window is restored first.
			app.prependListener("second-instance", this.secondInstanceHandler);
			app.on("browser-window-created", this.windowCreatedHandler);
		} catch (e) {
			console.error("Keep Alive: failed to register single-instance handling", e);
		}
	}

	private removeSingleInstance() {
		const app = this.remote?.app;
		if (app) {
			try {
				if (this.secondInstanceHandler)
					app.removeListener(
						"second-instance",
						this.secondInstanceHandler
					);
			} catch {
				/* already removed */
			}
			try {
				if (this.windowCreatedHandler)
					app.removeListener(
						"browser-window-created",
						this.windowCreatedHandler
					);
			} catch {
				/* already removed */
			}
		}
		this.secondInstanceHandler = null;
		this.windowCreatedHandler = null;
	}

	// ── macOS lifecycle ─────────────────────────────────────
	// A Mac app keeps running with no window, and its Dock icon brings the window back. Two
	// app-level events give that behaviour:
	//  - "before-quit" fires for Cmd+Q, Dock > Quit and logout/shutdown, before any window gets a
	//    close request. Treat it as a real quit, or the close veto would block all of them.
	//  - "activate" fires when the Dock icon is clicked: show the hidden window again.
	private registerMacLifecycle() {
		if (process.platform !== "darwin") return;
		const app = this.remote?.app;
		if (!app) return;
		this.removeMacLifecycle();
		this.beforeQuitHandler = () => {
			this.reallyQuitting = true;
			// If the quit gets cancelled (the process is still here a bit later), hide again
			// on the next window close.
			if (this.beforeQuitResetTimer) clearTimeout(this.beforeQuitResetTimer);
			this.beforeQuitResetTimer = setTimeout(() => {
				this.reallyQuitting = false;
				this.beforeQuitResetTimer = null;
			}, 5000);
		};
		this.activateHandler = () => this.showWindow();
		try {
			app.on("before-quit", this.beforeQuitHandler);
			app.on("activate", this.activateHandler);
		} catch (e) {
			console.error("Keep Alive: failed to register macOS lifecycle", e);
		}
	}

	private removeMacLifecycle() {
		const app = this.remote?.app;
		if (app) {
			try {
				if (this.beforeQuitHandler)
					app.removeListener("before-quit", this.beforeQuitHandler);
				if (this.activateHandler)
					app.removeListener("activate", this.activateHandler);
			} catch {
				/* already removed */
			}
		}
		if (this.beforeQuitResetTimer) clearTimeout(this.beforeQuitResetTimer);
		this.beforeQuitResetTimer = null;
		this.beforeQuitHandler = null;
		this.activateHandler = null;
	}

	// Destroy (not close) the pickers we kept hidden. destroy() skips the close/beforeunload
	// round trip; Obsidian's own picker "closed" handler only clears its reference.
	destroyHiddenPickers() {
		for (const w of this.hiddenPickers) {
			try {
				if (!w.isDestroyed()) w.destroy();
			} catch {
				/* already gone */
			}
		}
		this.hiddenPickers = [];
	}

	// ── Tray ──────────────────────────────────────
	private async createTray() {
		const remote = this.remote;
		if (!remote) return;
		this.destroyTray(); // guard against duplicates
		try {
			const { Tray, Menu } = remote;
			const icon = await this.resolveTrayIcon(remote);

			const tray = new Tray(icon);
			this.tray = tray;
			this.applyTrayLabels(tray, Menu);
			if (process.platform === "darwin") {
				// Mac menu bar convention: click opens / raises the window, right-click the menu.
				tray.on("click", () => this.showWindow());
				tray.on("right-click", () => {
					try {
						tray.popUpContextMenu(this.trayMenu);
					} catch (e) {
						console.error("Keep Alive: failed to show the tray menu", e);
					}
				});
			} else {
				tray.on("click", () => this.toggleWindow());
			}
			// macOS: swap the white/black icon when the system appearance changes.
			if (process.platform === "darwin") {
				try {
					this.appearanceSubId =
						remote.systemPreferences?.subscribeNotification(
							"AppleInterfaceThemeChangedNotification",
							() => void this.refreshTray()
						) ?? null;
				} catch {
					this.appearanceSubId = null;
				}
			}
		} catch (e) {
			console.error("Keep Alive: failed to create the tray icon", e);
			new Notice("Keep Alive: failed to create the tray icon.");
			this.tray = null;
		}
	}

	// White or black bundled icon? The setting wins; otherwise guess from the platform:
	// macOS follows the system appearance, GNOME's top bar is always dark, everything else
	// (Windows, KDE, ...) follows the theme.
	private useWhiteTrayIcon(remote: ElectronRemote): boolean {
		const choice = this.settings.trayIconColor;
		if (choice === "white") return true;
		if (choice === "black") return false;
		try {
			if (process.platform === "darwin")
				return (
					remote.systemPreferences?.getUserDefault(
						"AppleInterfaceStyle",
						"string"
					) === "Dark"
				);
			const desktop = (process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase();
			if (desktop.includes("gnome")) return true;
			return remote.nativeTheme?.shouldUseDarkColors ?? true;
		} catch {
			return true;
		}
	}

	// Tray icon: custom path → the real Obsidian app icon → fallback.
	private async resolveTrayIcon(
		remote: ElectronRemote
	): Promise<NativeImageLike> {
		const { nativeImage } = remote;
		// 1) user-supplied path
		if (this.settings.trayIconPath) {
			try {
				const c = nativeImage.createFromPath(
					this.settings.trayIconPath
				);
				if (!c.isEmpty()) return c;
			} catch {
				/* invalid path → bundled icon */
			}
		}
		// 2) bundled icon, white or black to suit the bar
		const white = this.useWhiteTrayIcon(remote);
		const name = white ? "tray-white" : "tray-black";
		const set = white ? TRAY_ICONS.white : TRAY_ICONS.black;
		// Write the 1x/2x pair into the plugin folder and load the 1x file: Electron attaches
		// both, and the high-DPI screen gets the sharp one (see TRAY_ICONS).
		try {
			const adapter = this.app.vault.adapter as {
				getBasePath?: () => string;
				writeBinary(path: string, data: ArrayBuffer): Promise<void>;
			};
			const dir = this.manifest.dir;
			const base = adapter.getBasePath?.();
			if (dir && base) {
				const toBytes = (b64: string) =>
					Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)).buffer;
				await adapter.writeBinary(`${dir}/${name}@2x.png`, toBytes(set.x2));
				await adapter.writeBinary(`${dir}/${name}.png`, toBytes(set.x1));
				const img = nativeImage.createFromPath(`${base}/${dir}/${name}.png`);
				if (!img.isEmpty()) return img;
			}
		} catch (e) {
			console.error("Keep Alive: bundled tray icon failed", e);
		}
		// 3) the files couldn't be written: use the 1x icon straight from memory (works, but soft
		// on high-DPI screens)
		return nativeImage.createFromDataURL(`data:image/png;base64,${set.x1}`);
	}

	private destroyTray() {
		if (this.appearanceSubId !== null) {
			try {
				this.remote?.systemPreferences?.unsubscribeNotification(
					this.appearanceSubId
				);
			} catch {
				/* already gone */
			}
			this.appearanceSubId = null;
		}
		if (this.tray) {
			try {
				this.tray.destroy();
			} catch {
				/* already destroyed */
			}
		}
		this.tray = null;
		this.trayMenu = null;
	}

	// Show the current vault in the tooltip and the right-click menu. With one tray icon per
	// vault open, this is what makes the icons tellable apart. (91 #22)
	private applyTrayLabels(
		tray: ElectronTray,
		Menu: ElectronRemote["Menu"]
	) {
		const vault = this.resolveVaultName();
		try {
			tray.setToolTip(this.renderTooltip(vault));
		} catch (e) {
			console.error("Keep Alive: failed to set the tooltip", e);
		}
		try {
			const menu = Menu.buildFromTemplate([
					// Disabled header — not clickable, it just says which vault this icon belongs to.
					{ label: vault, enabled: false },
					{ type: "separator" },
					{ label: "Show / Hide", click: () => this.toggleWindow() },
					{ type: "separator" },
					{
						label: "Relaunch Obsidian",
						click: () => this.relaunch(),
					},
					{
						label: "Quit completely",
						click: () => this.quitCompletely(),
					},
				]);
			this.trayMenu = menu;
			if (process.platform !== "darwin") tray.setContextMenu(menu);
		} catch (e) {
			console.error("Keep Alive: failed to set the context menu", e);
		}
	}

	// Resolve the vault name through several routes: app.vault.getName() returns an empty string
	// in some environments, which is why every tray tooltip looked identical up to 1.0.7.
	resolveVaultName(): string {
		try {
			const name = this.app.vault.getName();
			if (name && name.trim()) return name.trim();
		} catch {
			/* API unreachable → next candidate */
		}
		// last segment of the vault folder path
		try {
			const adapter = this.app.vault.adapter as unknown as {
				getBasePath?: () => string;
				basePath?: string;
			};
			const base = adapter?.getBasePath?.() ?? adapter?.basePath;
			if (base) {
				// Normalise separators to "/" — the last segment is the vault folder name.
				const seg = base
					.split("\\")
					.join("/")
					.split("/")
					.filter((part) => part.trim())
					.pop();
				if (seg && seg.trim()) return seg.trim();
			}
		} catch {
			/* adapter unreachable → next candidate */
		}
		// Window title "<note> - <vault> - Obsidian v1.x" → second-to-last segment
		try {
			const parts = document.title.split(" - ");
			if (parts.length >= 2) {
				const cand = parts[parts.length - 2]?.trim();
				if (cand) return cand;
			}
		} catch {
			/* document unreachable → final fallback */
		}
		return "Obsidian";
	}

	private renderTooltip(vault = this.resolveVaultName()): string {
		const template =
			this.settings.trayTooltip?.trim() || DEFAULT_SETTINGS.trayTooltip;
		const text = template.replace(/\{\{vault\}\}/g, vault).trim();
		// If the template renders empty, keep at least the vault name. Win32 szTip caps at 127 chars.
		return (text || vault).slice(0, 127);
	}

	// ── Window actions ───────────────────────────────
	toggleWindow() {
		const win = this.win;
		if (!win) return;
		try {
			if (win.isVisible() && !win.isMinimized()) {
				win.hide();
				this.updateDock();
			} else {
				this.showWindow();
			}
		} catch (e) {
			console.error("Keep Alive: toggleWindow failed", e);
		}
	}

	// Show = the main window plus every secondary window that was hidden with it.
	showWindow() {
		const win = this.win;
		if (!win) return;
		if (process.platform === "darwin" && this.settings.hideDockWhenHidden) {
			try {
				void this.remote?.app?.dock?.show?.();
			} catch {
				/* no dock */
			}
		}
		try {
			if (win.isMinimized()) win.restore();
			win.show();
		} catch {
			/* ignore restore failure */
		}
		this.restoreSecondaries();
		try {
			win.focus();
			// Coming back from a hidden Dock icon, the app has to be activated explicitly.
			if (process.platform === "darwin" && this.settings.hideDockWhenHidden)
				this.remote?.app?.focus?.({ steal: true });
		} catch {
			/* ignore focus failure */
		}
	}

	// Hide = the whole vault: pop-outs and the Settings window go to the tray with the main window.
	hideWindow() {
		const win = this.win;
		if (!win) return;
		this.hideSecondaries();
		try {
			win.hide();
		} catch {
			/* ignore hide failure */
		}
		this.updateDock();
	}

	// macOS: with "hide Dock icon" on, the Dock icon goes away while no
	// window is visible and comes back with the window. Only ever done while the tray icon
	// exists, so there is always a way back.
	updateDock() {
		if (process.platform !== "darwin") return;
		const remote = this.remote;
		const dock = remote?.app?.dock;
		if (!remote || !dock) return;
		try {
			const wantHidden =
				this.settings.hideDockWhenHidden &&
				this.settings.createTrayIcon &&
				this.tray !== null &&
				!(remote.BrowserWindow?.getAllWindows() ?? []).some(
					(w) => !w.isDestroyed() && w.isVisible()
				);
			if (wantHidden) dock.hide?.();
			else void dock.show?.();
		} catch (e) {
			console.error("Keep Alive: dock update failed", e);
		}
	}

	quitCompletely() {
		this.reallyQuitting = true;
		// Drop the hidden vault picker first: Obsidian only exits on window-all-closed, so a picker
		// left behind kept the process alive with no window and no tray (issue #3). Then close just
		// our window — not app.quit(): with several vaults open, quitting from one tray icon must
		// not pull the other vaults down (their plugin instances would veto and hide instead).
		this.destroyHiddenPickers();
		try {
			if (this.win) this.win.close();
			else this.remote?.app?.quit();
		} catch (e) {
			console.error("Keep Alive: quit failed", e);
			try {
				this.remote?.app?.quit();
			} catch {
				/* ignore quit failure */
			}
		}
	}

	relaunch() {
		try {
			this.reallyQuitting = true;
			const app = this.remote?.app;
			// app.exit() destroys the windows one by one without a before-quit. Obsidian's "closed"
			// handler then sees other windows still alive and marks THIS vault as not open — so
			// the relaunched Obsidian showed the vault picker instead of the vault. Two windows
			// can still be alive at that point: a hidden vault picker (drop it first) and, with
			// several vaults open, the other vaults (tell Obsidian a quit is under way, which is
			// what a real before-quit would have done).
			this.destroyHiddenPickers();
			try {
				app?.emit("before-quit");
			} catch {
				/* not reachable → single-vault relaunch still works */
			}
			app?.relaunch();
			app?.exit(0);
		} catch (e) {
			console.error("Keep Alive: relaunch failed", e);
		}
	}

	async loadSettings() {
		const data = (await this.loadData()) as
			| Partial<BackgroundTraySettings>
			| null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
		// Never leave the app with neither a Dock icon nor a tray icon.
		if (!this.settings.createTrayIcon) this.settings.hideDockWhenHidden = false;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// Re-apply only the tooltip and menu labels (no icon re-extraction, no flicker).
	refreshTrayLabels() {
		const tray = this.tray;
		const remote = this.remote;
		if (!tray || !remote) return;
		this.applyTrayLabels(tray, remote.Menu);
	}

	// Rebuild the tray so setting changes take effect immediately
	async refreshTray() {
		this.destroyTray();
		if (this.remote && this.settings.createTrayIcon)
			await this.createTray();
	}
}

class BackgroundTraySettingTab extends PluginSettingTab {
	plugin: BackgroundTrayPlugin;

	constructor(app: App, plugin: BackgroundTrayPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const mac = process.platform === "darwin";

		new Setting(containerEl)
			.setName("Create tray icon")
			.setDesc(
				mac
					? "Add an icon to the menu bar. Click opens the window, right-click shows the menu. Required while the Dock icon is hidden."
					: "Add an icon to the system tray. Left-click toggles show/hide."
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.createTrayIcon)
					.setDisabled(mac && this.plugin.settings.hideDockWhenHidden)
					.onChange(async (v) => {
						this.plugin.settings.createTrayIcon = v;
						await this.plugin.saveSettings();
						await this.plugin.refreshTray();
						this.display();
					})
			);

		if (mac) {
			new Setting(containerEl)
				.setName("Hide Dock icon while hidden")
				.setDesc(
					"Remove the Dock icon while all windows are hidden; it comes back when you show the window from the menu bar icon. Needs the tray icon, so the two can't both be off."
				)
				.addToggle((t) =>
					t
						.setValue(this.plugin.settings.hideDockWhenHidden)
						.setDisabled(!this.plugin.settings.createTrayIcon)
						.onChange(async (v) => {
							this.plugin.settings.hideDockWhenHidden = v;
							await this.plugin.saveSettings();
							this.plugin.updateDock();
							this.display();
						})
				);
		}

		new Setting(containerEl)
			.setName("Focus existing window on relaunch")
			.setDesc(
				"Relaunching Obsidian while it is hidden in the tray restores the existing window instead of opening the vault picker."
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.focusOnRelaunch)
					.onChange(async (v) => {
						this.plugin.settings.focusOnRelaunch = v;
						await this.plugin.saveSettings();
						// Off: let go of any picker we hid, or Obsidian's next relaunch would
						// focus that invisible window and show nothing.
						if (!v) this.plugin.destroyHiddenPickers();
					})
			);

		new Setting(containerEl)
			.setName("Tray icon colour")
			.setDesc(
				"White or black, to suit your bar. Automatic follows the system theme."
			)
			.addDropdown((d) =>
				d
					.addOption("auto", "Automatic")
					.addOption("white", "White")
					.addOption("black", "Black")
					.setValue(this.plugin.settings.trayIconColor)
					.onChange(async (v) => {
						this.plugin.settings.trayIconColor =
							v === "white" || v === "black" ? v : "auto";
						await this.plugin.saveSettings();
						await this.plugin.refreshTray();
					})
			);

		new Setting(containerEl)
			.setName("Tray icon image")
			.setDesc(
				"Absolute path to a custom tray icon. Leave empty to use the built-in icon."
			)
			.addText((txt) =>
				txt
					.setPlaceholder("/path/to/icon.png")
					.setValue(this.plugin.settings.trayIconPath)
					.onChange(async (v) => {
						this.plugin.settings.trayIconPath = v.trim();
						await this.plugin.saveSettings();
						await this.plugin.refreshTray();
					})
			);

		new Setting(containerEl)
			.setName("Tray tooltip")
			.setDesc(
				`{{vault}} is replaced with the vault name. Current vault: "${this.plugin.resolveVaultName()}"`
			)
			.addText((txt) =>
				txt
					.setPlaceholder("{{vault}} — Obsidian")
					.setValue(this.plugin.settings.trayTooltip)
					.onChange(async (v) => {
						this.plugin.settings.trayTooltip = v;
						await this.plugin.saveSettings();
						this.plugin.refreshTrayLabels();
					})
			);
	}
}
