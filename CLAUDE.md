# CLAUDE.md — Keep Alive (code repo)

Obsidian plugin that keeps Obsidian running in the background when the window is closed, with an
optional tray / menu bar icon. Fork of `Synaphi/background-tray` (MIT); see the README.

## Repo facts

- **Code**: GitHub `tilgoldan/keep-alive`, a fork of `Synaphi/background-tray`.
- **Platforms**: developed and tested on macOS and Linux (GNOME). Windows is untested.
- **Releases**: pushing a tag that matches the `manifest.json` version runs
  `.github/workflows/release.yml`, which builds and attaches `main.js` / `manifest.json` /
  `styles.css` plus build provenance as a draft release. Publish the draft afterwards.
  Obsidian only installs those three files, so every asset has to end up inside `main.js`.
- **Deploying locally**: copy `main.js`, `manifest.json` and `styles.css` into
  `<vault>/.obsidian/plugins/keep-alive/`, then toggle the plugin. If the vault's `.obsidian`
  folder is synced (Obsidian Sync, LiveSync), deploying from two machines at once makes
  `main.js` overwrite itself.
- ⚠️ **CI cannot verify tray / Electron behaviour.** The smoke test doesn't run Electron, so
  always check changes in a real Obsidian (close, Dock/tray click, Cmd+Q, relaunch) before
  tagging.
- **Version scheme (inherited from upstream)**: the version is the date, `<year>.<MM>.<DD>`, with
  the first number counting years since 2026 (`1.09.13` = 2026-09-13). A second release on the
  same day appends a fourth number (`1.09.13.2`); never use letter suffixes, because Obsidian
  compares versions with `parseInt` per dot-part. Bump `manifest.json`, `package.json` and
  `versions.json` together by hand, and the git tag must equal the `manifest.json` version
  exactly. Don't run `npm version`: it normalises `1.09.14` to `1.9.14`.
- **Release order**: push the tag first, wait for the Actions draft, publish it, then push
  `main`, so Obsidian never advertises a version whose download still 404s.

## Build / test

```bash
npm install
npm run dev      # esbuild watch → main.js
npm run build    # tsc typecheck + esbuild production (expect exit 0)
node smoke.cjs   # regression smoke over the core paths, no Electron needed (expect ALL PASS)
```

Build notes:

- esbuild `external` must include `electron` and `@electron/remote`, or the bundle breaks.
- PNGs are imported as base64 strings (`loader: { ".png": "base64" }`, typed in `images.d.ts`).
  The tray icons live in `assets/icons/`: white and black, a 13×16 px `name.png` plus a 26×32 px
  `name@2x.png`. Keep those sizes.
- With `strict: true`, the `settings` field needs `settings!:`.

## Behaviour notes (learned the hard way)

- **Tray icons**: the plugin writes the 1×/@2× pair next to each other into its plugin folder and
  loads the 1× file by path, so Electron attaches both. Electron's `scaleFactor` option and
  loading an `@2x` file directly misreport the size (÷ scale²) in this Electron version, and
  `setTemplateImage` doesn't tint the tray, so the colour is chosen in code (white/black).
- **Quitting on macOS**: the close veto would block Cmd+Q, Dock > Quit and shutdown. The
  `before-quit` event lifts it; `activate` (Dock click) shows the window again.
- **macOS menu bar clicks**: `setContextMenu` makes a left click open the menu as well, so on
  macOS the menu is popped up manually on `right-click`.
- **Hide Dock icon** (macOS only) is only allowed while the tray icon exists, so there is always a
  way back.

## Conventions

- Write code, comments and user-facing strings in English.
- Wrap every Electron call in try/catch — never crash the app.
- `onunload` must undo everything the plugin did (listeners, tray, Dock, patched `window.open`),
  so disabling the plugin restores stock behaviour.
- Keep the Obsidian logo unmodified and single-colour (white or black), per Obsidian's brand
  guidelines (https://obsidian.md/brand).
