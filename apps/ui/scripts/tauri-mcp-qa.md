# Native Tauri manual QA via `hypothesi/mcp-server-tauri` (dev-only)

This repo already includes dev-only wiring for the Tauri MCP bridge plugin + an MCP server runner.

The intent is to enable **native desktop QA automation** without affecting production builds.

## Recommendation (what to use)

Use the existing **yarn scripts** (no new dev dependency required):
- `yarn test:e2e:desktop:native` → canonical repo-level native desktop E2E lane; delegates to the package-owned activity-surfaces capture owner in `apps/ui`
- `yarn --cwd apps/ui tauri:qa` → **canonical one-shot**: starts the desktop app + MCP server, runs the deterministic onboarding wizard QA capture, then exits.
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

`tauri:qa` expects a reachable Expo/Metro dev server (default `http://localhost:8081`). Start one first (for example `yarn --cwd apps/ui start`).

By default, `tauri:qa` will:
- ensure internal `@happier-dev/*` workspace packages have their `dist/` outputs built (avoids Metro crashing on missing export entrypoints),
- ensure the `hsetup` sidecar entrypoint is prepared,
- start the stack-owned `tauri dev` flow,
- run `npx -y @hypothesi/tauri-mcp-server` alongside it.
- run the deterministic onboarding wizard capture (`apps/ui/scripts/qa/tauriOnboardingWizardMcpQa.mjs`, via `yarn --cwd apps/ui tauri:mcp:wizard:qa`),
- and then shut everything down (one-shot mode).

To keep the app + MCP server running for manual QA, add `--serve`:

```bash
yarn --cwd apps/ui tauri:qa --serve
```

`tauri:qa` writes the child process logs under `.project/logs/bootstrap-qa/tauri-qa-*` by default. Add `--tee-logs` if you also want to stream logs to your terminal.

If Metro previously crashed with a "Cannot find module .../dist/..." error, restart the Metro dev server after running `tauri:qa` (the build step fixes the missing files, but a crashed Metro process won't recover by itself).

## Avoid TUI for QA

Prefer `yarn --cwd apps/ui tauri:qa` / `--serve` and the MCP CLI over any stack TUI, to keep logs/artifacts deterministic and to avoid filling up agent context with terminal UI output.

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
- assumes the stack-owned `tauri:qa --serve` launcher (or another Tauri dev run) is already running,
- ensures internal `@happier-dev/*` workspace packages have their `dist/` outputs built (so the wizard can render reliably in Metro/Tauri),
- opens a Tauri driver session,
- captures the pre-auth landing surface through the standard onboarding root path,
- captures the current wizard steps in order:
  - `onboarding-wizard` / welcome
  - relay selection (`onboarding-wizard-relay:*`)
  - auth entry actions (`welcome-*`)
  - restore / add-device (`restore-*`)
  - lost-access / reset (`lost-access-*`)
  - optional post-auth setup wizard capture when the authenticated runtime exposes it (`setupWizard.*`)
- exercises each visible relay option row in sequence and stores relay-specific artifacts under `03-relay-<choice>.{png,structure.yml,a11y.yml}` when available,
- writes artifacts under `.project/logs/bootstrap-qa/tauri-onboarding-wizard-YYYYMMDD-.../`,
- and appends the evidence paths to `.project/plans/todo/bootstrap/happier-bootstrap-qa-tracking-2026-03-30.md`.

If an OS permission or picker dialog appears, complete it once manually and re-run; those steps are documented in the generated `manual-steps.md`.

## Deterministic activity-surfaces QA capture

To capture the desktop overlay settings surface and the overlay window states in a deterministic order:

```bash
yarn test:e2e:desktop:native
```

That canonical root-owned native desktop E2E lane delegates to `yarn --cwd apps/ui test:native-e2e:activity-surfaces`, which remains the package-owned implementation entrypoint wrapping the Tauri launcher plus the activity-surfaces MCP harness in one command.

If you need to attach to an already-running Tauri QA launcher and invoke only the lower-level harness directly:

```bash
yarn --cwd apps/ui tauri:mcp:activity-surfaces:qa
```

This script:
- assumes the stack-owned `tauri:qa --serve` launcher (or another Tauri dev run) is already running,
- ensures internal `@happier-dev/*` workspace packages have their `dist/` outputs built,
- opens a Tauri driver session,
- navigates to the desktop overlay settings section,
- toggles the overlay on if it is currently off,
- forces notch-integrated and floating-overlay presentation modes in sequence for deterministic premium capture,
- tolerates the expected floating-host fallback when forced notch presentation runs on a machine without a notch-capable built-in display,
- validates notch captures against both the computed placement intent and the applied native-frame top-edge contract,
- captures the five-step premium artifact set:
  - `01-settings-overlay.*`
  - `02-overlay-route.*`
  - `03-overlay-collapsed-notch.*`
  - `04-overlay-expanded-notch.*`
  - `05-overlay-floating-fallback.*`
- writes artifacts under `.project/logs/activity-surfaces-qa/tauri-activity-surfaces-YYYYMMDD-.../`,
- and appends the evidence paths to `.project/plans/todo/activity-surfaces/happier-activity-surfaces-qa-tracking-2026-04-05.md`.

If you need to avoid the shared default `activity-surfaces-qa` stack while doing final proof or manual QA, export a dedicated stack name before running the native lane:

```bash
HAPPIER_STACK_STACK=activity-surfaces-premium-lead-qa \
  yarn --cwd apps/ui test:native-e2e:activity-surfaces
```

## Window / crash checks

- The latest captured backend state showed one visible `main` window (`window_count: 1`), so the desktop window itself did not crash in that run.
- If the window really closes on a future run, inspect the run folder’s `00-backend-state.json` and `99-console-logs.json` first; those are the fastest evidence sources for whether the app exited, hid, or just navigated away.

## Security notes

- Do **not** add MCP permissions to production capabilities.
- Keep MCP tooling enabled only in local dev / QA builds.
