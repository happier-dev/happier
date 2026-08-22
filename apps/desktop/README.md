# @happier-dev/desktop

An Electron desktop target for Happier, built to run **alongside** the Tauri target in
`apps/ui/src-tauri` during an evaluation period. Both load the same web bundle from the same
`apps/ui` codebase; they differ only in the native host underneath.

This supersedes the earlier "there is no Electron" ruling in
`.project/reviews/browser-desktop-shell-spike/decision.md` (BRW-12, 2026-06-21). Neither target is
retired: the point of having both is to compare them on real workloads and migrate behaviour
incrementally. Nothing here changes the Tauri target, and nothing in `apps/ui/sources` was modified
to make this work.

## How the app reaches the host

`apps/ui/sources/utils/platform/tauri.ts` is the whole JS-to-native seam: three functions reading
`window.__TAURI_INTERNALS__`. The preload in `src/preload/index.ts` exposes an object of that exact
shape over `ipcRenderer`, so the React app — all ~1.13M lines of it — runs unmodified. The renderer
cannot tell which host it is on, and `isTauriDesktop()` correctly returns `true` on both.

Command names, event delivery, and the `@tauri-apps/api` channel protocol are all honoured as-is.
`plugin:event|listen` returns the callback id as the event id, which is what lets the renderer's
`unregisterListener` release the right slot.

## Running it

```bash
cd apps/desktop
yarn build          # compiles src/ -> build/ with the repo's TypeScript runner
yarn start          # opens the window (runs yarn build first)
yarn test           # node:test suite over the compiled output
yarn typecheck
```

Environment:

| Variable | Effect |
| --- | --- |
| `HAPPIER_DESKTOP_MODE=dev` | Load `http://localhost:8081` (the Expo dev server) instead of the exported bundle. |
| `HAPPIER_DESKTOP_SERVER_URL` | Relay the app should start against, published as `window.__HAPPIER_WEB_RUNTIME_CONFIG__`. |
| `HAPPIER_DESKTOP_SERVER_CONTEXT` | Companion to the above; set to `stack` for a stack launch. |
| `HAPPIER_DESKTOP_INVOKE_LOG` | Append one JSON line per `invoke` to this path. Every invoke is logged to stdout regardless. |

Production mode serves `apps/ui/dist`. Rebuild that bundle from `apps/ui` with
`yarn tauri:prepare:build`; both desktop targets consume the same export.

### You will need a relay

Without `HAPPIER_DESKTOP_SERVER_URL`, and unless the web bundle was exported with
`EXPO_PUBLIC_HAPPIER_SERVER_URL` baked in, the app starts with no relay and shows
*"Relay not supported"*. This is not specific to this target: the Tauri build of the same bundle
behaves identically, because `getWebSameOriginServerUrl` only seeds a relay from an `http(s)` page
origin and both desktop hosts serve the app from a private scheme. A stack launch normally supplies
the value; `HAPPIER_DESKTOP_SERVER_URL` is the equivalent here.

## Why a private scheme rather than loopback HTTP

The bundle references its assets by absolute path, so it cannot load from `file://`. The first
implementation served it from `http://127.0.0.1:8899`, and the app then offered *its own asset
server* as the relay — because `getWebSameOriginServerUrl` treats an `http(s)` page origin as a
relay candidate. Serving from `happier://localhost` (registered standard, secure, fetch- and
stream-capable) reproduces what Tauri does with `tauri://localhost`, keeps the origin stable so the
signed-in session survives a restart, and keeps the app's relay resolution identical across targets.

## What is implemented

Implemented for real:

- `desktop_show_main_window`, `desktop_set_window_mode`
- `desktop_get_window_chrome_policy`, `desktop_get_window_state`
- `desktop_minimize_window`, `desktop_toggle_window_maximize`, `desktop_close_window`
- `desktop_get_autostart_enabled`, `desktop_set_autostart_enabled`
- `desktop_read_stack_boot_credentials` — a port of the Tauri implementation, same env vars and
  same candidate key paths
- `plugin:event|listen`, `|unlisten`, `|emit`, `|emit_to`
- `plugin:http|fetch`, `|fetch_send`, `|fetch_read_body`, `|fetch_cancel` — every `http(s)` request
  the app makes on desktop is routed through this plugin, so it is part of the boot path

Everything else in `src/main/commands/inventory.ts` — the tray, activity and pet overlays, the
embedded browser, hosted artifacts, system tasks, and the updater — rejects with
`HAPPIER_DESKTOP_NOT_IMPLEMENTED: <command>`. That prefix is the contract: a rejection carrying it
means this target has no implementation, never that the operation failed. **No command in this
target returns fabricated data.** Callers already treat command failures as "feature unavailable",
so the app degrades rather than breaks.

Known gaps beyond the command list:

- `desktop_set_window_mode` records the mode but does not apply or persist window geometry.
- `desktop_start_window_dragging` is unimplemented; on Windows and Linux the app expects custom
  window controls, which need `-webkit-app-region` styling rather than a host command.
- No tray, no overlay windows, no auto-update, no packaging or code signing.
- macOS only so far. Nothing in the code is macOS-specific beyond the `hiddenInset` title bar, but
  Windows and Linux have not been run.

## Workspace installation

`apps/desktop` is listed in the root `package.json` workspaces. Electron was installed directly into
`apps/desktop/node_modules` to avoid disturbing the shared checkout's `node_modules` and `yarn.lock`
while other work was in flight; a normal root `yarn install` will hoist it and is the intended
steady state.
