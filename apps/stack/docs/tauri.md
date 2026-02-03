# Tauri desktop app (optional)

The Tauri app is a native desktop wrapper around the web UI. It’s useful when you want:

- a native desktop window (instead of a browser tab)
- separate storage from the “regular” Happy desktop app (so it doesn’t reuse old server URLs/auth)

## Important behavior

- The Tauri app must embed an explicit API base URL.
- By default, `hstack` will embed:
  - a **Tailscale Serve** `https://*.ts.net` URL if it detects one on this machine (so the built app can be copied to other devices on the same tailnet), otherwise
  - the local loopback URL `http://127.0.0.1:<port>` (same-machine only).
- If you change what URL you want embedded, rebuild the Tauri app.

## Prereqs

- Rust toolchain installed
- Tauri build dependencies installed for your OS

## Build it

Build (one-off):

```bash
hstack build --tauri
```

Or during bootstrap:

```bash
hstack bootstrap --tauri
```

## Run it

1) Start the local server (or install the service):

```bash
hstack start
```

2) Launch the built app bundle (location is under `~/.happier/stacks/main/tauri-target/`).

## “Portable” Tauri builds (send to another computer)

If you build the Tauri app while Tailscale Serve is enabled on the server machine, the app will embed the `https://*.ts.net` URL and can be copied to another computer.

Requirements:

- The server machine is running `hstack start` and Tailscale Serve is enabled
- The other computer is on the same tailnet and can access the `https://*.ts.net` URL

## Configuration (high-signal)

- `HAPPIER_STACK_TAURI_IDENTIFIER` (default `com.happier.stack`)
- `HAPPIER_STACK_TAURI_PRODUCT_NAME` (default `Happier`)
- `HAPPIER_STACK_TAURI_DEBUG=0` (build release-like without devtools)
- `HAPPIER_STACK_TAURI_SERVER_URL` (force the embedded API URL)
- `HAPPIER_STACK_TAURI_PREFER_TAILSCALE=0` (disable Tailscale detection; always embed `127.0.0.1`)
