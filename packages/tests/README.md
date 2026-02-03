# `@happier-dev/tests`

Real end-to-end tests for Happier (server-light + real sockets + real DB).

This workspace is intentionally **not** under `apps/*` so it can act as a shared test harness for the whole repo.

## Commands

- Core deterministic e2e: `yarn workspace @happier-dev/tests test`
- Stress (seeded chaos): `yarn workspace @happier-dev/tests test:stress`
- Providers (real provider CLIs, opt-in): `yarn workspace @happier-dev/tests test:providers`
- Typecheck: `yarn workspace @happier-dev/tests typecheck`

Root aliases may exist (e.g. `yarn test:e2e`), but the workspace commands above are the source of truth.

## Suites

- `suites/core-e2e/*`: release-gate candidates (fast, deterministic)
- `suites/stress/*`: nightly/on-demand (repeat + chaos + flake classification)
- `suites/providers/*`: opt-in “real provider contract” tests (slow, may consume provider credits)

## Providers suite (opt-in)

By default, `test:providers` is a fast no-op. Enable explicitly:

```bash
HAPPY_E2E_PROVIDERS=1 HAPPY_E2E_PROVIDER_OPENCODE=1 yarn workspace @happier-dev/tests test:providers
```

### Provider matrix runner

The entrypoint is `suites/providers/provider.matrix.test.ts`, backed by:

- `src/testkit/providers/harness.ts`
- `src/testkit/providers/scenarios.ts`

### Environment flags

- `HAPPY_E2E_PROVIDERS=1`: enable provider contract matrix
- `HAPPY_E2E_PROVIDER_CLAUDE=1`: enable Claude scenarios (requires a working Claude auth/config)
- `HAPPY_E2E_PROVIDER_OPENCODE=1`: enable OpenCode scenarios (more providers will follow)
- `HAPPY_E2E_PROVIDER_WAIT_MS=...`: scenario timeout (default: 240000)
- `HAPPY_E2E_PROVIDER_FLAKE_RETRY=1`: retry once and fail as `FLAKY` if it passes on retry
- `HAPPY_E2E_PROVIDER_UPDATE_BASELINES=1`: write/update baseline snapshots under `packages/tests/baselines/providers/*`
- `HAPPY_E2E_PROVIDER_STRICT_KEYS=1`: fail if scenarios observe unexpected fixture keys (default: allow extra keys for forward-compat)
- `HAPPY_E2E_PROVIDER_YOLO_DEFAULT=1|0`: default whether provider CLI is started with `--yolo` (default: `1`)
- Scenario selection:
  - `HAPPY_E2E_PROVIDER_SCENARIOS=execute_trace_ok,execute_error_exit_2`
  - `HAPPY_E2E_PROVIDER_SCENARIO_TIER=smoke` (or `extended`)

Current OpenCode scenario ids:
- `execute_trace_ok` (smoke)
- `execute_error_exit_2` (smoke)
- `read_known_file` (extended)
- `search_known_token` (extended)
- `glob_list_files` (extended)
- `edit_write_file_and_cat` (extended)
- `permission_surface_outside_workspace` (extended, runs with YOLO off + auto-approvals)
- `permission_deny_outside_workspace` (extended, runs with YOLO off + auto-deny + verifies file did not get written)

Current Claude scenario ids:
- `bash_echo_trace_ok` (smoke)
- `read_known_file` (extended)
- `permission_surface_outside_workspace` (extended, YOLO off + auto-approve + verifies file written)
- `permission_deny_outside_workspace` (extended, YOLO off + auto-deny + verifies file not written)

### What the harness does (high level)

- Starts a real local `server-light`
- Creates auth via `/v1/auth`
- Creates a session with legacy encryption and writes a session-attach file
- Spawns `yarn workspace @happier-dev/cli dev <provider> --existing-session <id> ...`
- Sends encrypted prompts to `/v2/sessions/:id/messages`
- Waits for tool trace (`HAPPIER_STACK_TOOL_TRACE_FILE`)
- Extracts fixtures using `@happier-dev/cli tool:trace:extract`
- Asserts scenario invariants (fixture keys + payload shape + optional workspace file checks)
- Optionally compares extracted fixture keys + payload shapes against committed baselines

## Adding a new provider

1) Add a provider descriptor in `src/testkit/providers/harness.ts` (`providerCatalog()`):
   - `id`, `enableEnvVar`, `protocol`, `traceProvider`, `requiresBinaries`
   - CLI spawn args (`cli.subcommand`, `cli.extraArgs`)
2) Add scenarios (new `src/testkit/providers/scenarios.<provider>.ts`) and wire them in via `scenariosForProvider()`.
3) Keep scenarios small and explicit (single tool call, deterministic commands/paths).
