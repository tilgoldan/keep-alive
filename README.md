# Keep Alive

Keep Obsidian running in the background when you close the window, with an optional tray or menu bar icon.

> **Fork notice:** Keep Alive is a fork of [Synaphi/background-tray](https://github.com/Synaphi/background-tray) (MIT). It adds native macOS behaviour. Not affiliated with or endorsed by Obsidian; "Obsidian" and its logo are trademarks of Obsidian.

Closing the Obsidian window normally tears down the vault, and everything running inside it stops. Keep Alive hides the window instead, so Obsidian carries on working. Turn the plugin off and Obsidian behaves exactly as before.

> Desktop only. Developed and tested on macOS and on Linux (GNOME). Windows should work but is untested.

## Why keep Obsidian running?

- **Plugins that run in the background keep working.** For example an MCP server, or any plugin that serves or syncs data, stays up after you close the window.
- **Sync keeps going.** Obsidian Sync (and any other background sync) doesn't pause until you reopen the app.
- **Instant reopen.** Bringing the window back is immediate: no cold start, no vault picker.

## Features

- **Hide on close** — closing the window (the X button) hides Obsidian instead of quitting. Quitting still works: Cmd+Q, the Dock's Quit and shutdown on macOS, or **Quit completely** from the tray menu.
- **Tray / menu bar icon** (optional) — a bundled single-colour Obsidian glyph, sharp on high-DPI screens. The colour is Automatic (follows the system theme), White or Black, and a custom icon path overrides it.
  - **macOS:** click opens and raises the window, right-click shows the menu.
  - **Elsewhere:** left-click toggles show/hide, right-click shows the menu.
  - The menu is headed by the vault name, then Show / Hide, Relaunch, Quit completely.
- **macOS behaviour** — clicking the Dock icon brings the window back. An optional setting hides the Dock icon while all windows are hidden; it needs the tray icon, so the two can't both be off.
- **Single-instance focus** — relaunching Obsidian while it's hidden restores the existing window instead of opening the vault switcher.
- **Pop-outs come along** — pop-out windows and the Settings window hide and return together with the main window.
- **Tells your vaults apart** — with several vaults open you get one tray icon each; the tooltip (`{{vault}}` is replaced with the vault name) and the menu header show that vault's name.
- **Commands** — *Show window*, *Hide window* and *Show / Hide window* in the command palette, for hotkeys.
- Turning the plugin off restores all default behaviour (no leftover listeners).

On GNOME, which has no tray, a hidden Obsidian appears under **Background Apps** in the Quick Settings menu.

## Install

Keep Alive isn't in the community plugin store. Install it manually:

1. Build it (see below) or take `main.js`, `manifest.json` and `styles.css` from a release.
2. Copy the three files into `<vault>/.obsidian/plugins/keep-alive/`.
3. Enable it under Settings → Community plugins.

## Usage

Close the window and Obsidian keeps running. Bring it back from the tray or menu bar icon, the Dock icon (macOS), the command palette, or by launching Obsidian again. To really quit, use Cmd+Q on macOS or **Quit completely** in the tray menu.

## Building

```bash
npm install
npm run dev     # watch build → main.js
npm run build   # typecheck + production bundle
```

The tray icons live in `assets/icons/` and are inlined into `main.js` by the build.

## Credits and history

This plugin is a fork of Synaphi's [background-tray](https://github.com/Synaphi/background-tray); the close-to-tray core, single-instance handling and multi-vault support are theirs. Their release notes cover everything up to version 1.09.14: see the [upstream releases](https://github.com/Synaphi/background-tray/releases).

## License

MIT © Synaphi, Til Goldan
