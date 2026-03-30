# Native Tauri manual QA via `hypothesi/mcp-server-tauri` (dev-only)

This repo already includes dev-only wiring for the Tauri MCP bridge plugin + an MCP server runner.

The intent is to enable **native desktop QA automation** without affecting production builds.

## Recommendation (what to use)

Use the existing **yarn scripts** (no new dev dependency required):
- `yarn --cwd apps/ui tauri:qa` → starts the desktop app (stack-owned dev flow) and also runs the MCP server.
- `yarn --cwd apps/ui tauri:mcp:server` → runs only the MCP server (useful if your MCP client spawns it).

Avoid adding the MCP server as a dev dependency unless we need offline installs or want to pin a version for CI.

## Preconditions

- Rust toolchain installed (Tauri build runs Cargo).
- Node 20+ for dev tooling.
- Tauri desktop dev runs in **debug** mode (the MCP bridge plugin is registered behind `debug_assertions`).

## Start the app + MCP server

```bash
yarn --cwd apps/ui tauri:qa
```

`tauri:qa` expects a reachable Expo/Metro dev server (default `http://localhost:8081`). Start one first (for example `yarn --cwd apps/ui start`), or run it via `yarn tui:with-tauri` (which already starts Metro).

This will then:
- ensure the `hsetup` sidecar entrypoint is prepared,
- start the stack-owned `tauri dev` flow,
- run `npx -y @hypothesi/tauri-mcp-server` alongside it.

## MCP client configuration (typical usage)

Most MCP clients will spawn the server directly. Manual config snippet:

```json
{
  "mcpServers": {
    "tauri": {
      "command": "npx",
      "args": ["-y", "@hypothesi/tauri-mcp-server"]
    }
  }
}
```

## Install into an MCP client (optional)

If you use `install-mcp` (recommended by Hypothesi) in a **non-interactive shell**, pass explicit non-interactive flags:

```bash
npx -y install-mcp @hypothesi/tauri-mcp-server --client claude-code --yes --oauth no
```

Notes:
- This command updates your local MCP client config (external side effect). Use it only on your own machine/profile.
- For interactive shells you can omit `--yes --oauth no`, but for CI/TTY-less shells you generally should not.

## MCP CLI (optional)

This repo also exposes the MCP driver CLI via yarn scripts:

- Start a driver session on the default port:

```bash
yarn --cwd apps/ui tauri:mcp:session:start
```

- Or run the CLI directly:

```bash
yarn --cwd apps/ui tauri:mcp:cli -- --help
```

## Security notes

- Do **not** add MCP permissions to production capabilities.
- Keep MCP tooling enabled only in local dev / QA builds.
