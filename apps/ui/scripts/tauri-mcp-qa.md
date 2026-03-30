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
- ensure internal `@happier-dev/*` workspace packages have their `dist/` outputs built (avoids Metro crashing on missing export entrypoints),
- ensure the `hsetup` sidecar entrypoint is prepared,
- start the stack-owned `tauri dev` flow,
- run `npx -y @hypothesi/tauri-mcp-server` alongside it.

If Metro previously crashed with a "Cannot find module .../dist/..." error, restart the Metro dev server after running `tauri:qa` (the build step fixes the missing files, but a crashed Metro process won't recover by itself).

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

## Deterministic onboarding wizard QA capture

To capture screenshots + DOM/a11y snapshots for the onboarding / setup surfaces in a deterministic order:

```bash
yarn --cwd apps/ui tauri:mcp:wizard:qa
```

This script:
- assumes the stack-owned `tauri:qa` launcher is already running,
- ensures internal `@happier-dev/*` workspace packages have their `dist/` outputs built (so the wizard can render reliably in Metro/Tauri),
- opens a Tauri driver session,
- captures the current wizard steps in order:
  - `onboarding-wizard` / welcome
  - relay selection (`onboarding-wizard-relay:*`)
  - auth entry actions (`welcome-*`)
  - restore / add-device (`restore-*`)
  - lost-access / reset (`lost-access-*`)
  - optional post-auth setup wizard capture when the authenticated runtime exposes it (`setupWizard.*`)
- writes artifacts under `.project/logs/bootstrap-qa/tauri-onboarding-wizard-YYYYMMDD-.../`,
- and appends the evidence paths to `.project/plans/todo/bootstrap/happier-bootstrap-qa-tracking-2026-03-30.md`.

If an OS permission or picker dialog appears, complete it once manually and re-run; those steps are documented in the generated `manual-steps.md`.

## Window / crash checks

- The latest captured backend state showed one visible `main` window (`window_count: 1`), so the desktop window itself did not crash in that run.
- If the window really closes on a future run, inspect the run folder’s `00-backend-state.json` and `99-console-logs.json` first; those are the fastest evidence sources for whether the app exited, hid, or just navigated away.

## Security notes

- Do **not** add MCP permissions to production capabilities.
- Keep MCP tooling enabled only in local dev / QA builds.
