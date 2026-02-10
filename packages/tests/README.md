# `@happier-dev/tests`

Real end-to-end tests for Happier (server-light + real sockets + real DB).

This workspace is intentionally **not** under `apps/*` so it can act as a shared test harness for the whole repo.

## What this package is for

This workspace exists to answer one question:

> “If we ship this build, will the real product still work end-to-end?”

So these tests intentionally run **real components** (server-light, DB, sockets, CLI agents) and assert on:
- real HTTP contracts (`/v1/*`, `/v2/*`)
- real Socket.IO update routing + reconnection behavior
- real message idempotency semantics (ACKs + broadcast rules)
- real permission approval lifecycle (RPC + agentState)
- provider “contract drift” detection via tool-trace fixtures + baselines

## Commands

- Core deterministic e2e: `yarn workspace @happier-dev/tests test`
- Core deterministic e2e (fast lane): `yarn workspace @happier-dev/tests test:core:fast`
- Core deterministic e2e (slow lane): `yarn workspace @happier-dev/tests test:core:slow`
- Stress (seeded chaos): `yarn workspace @happier-dev/tests test:stress`
- Providers (real provider CLIs, opt-in): `yarn workspace @happier-dev/tests test:providers`
- Typecheck: `yarn workspace @happier-dev/tests typecheck`

Root aliases may exist (e.g. `yarn test:e2e`), but the workspace commands above are the source of truth.

## Providers convenience commands

The provider suite is opt-in, but you can run common presets via yarn scripts:

- `yarn workspace @happier-dev/tests providers:opencode:smoke`
- `yarn workspace @happier-dev/tests providers:claude:smoke`
- `yarn workspace @happier-dev/tests providers:codex:smoke`
- `yarn workspace @happier-dev/tests providers:kilo:smoke`
- `yarn workspace @happier-dev/tests providers:qwen:smoke`
- `yarn workspace @happier-dev/tests providers:kimi:smoke`
- `yarn workspace @happier-dev/tests providers:auggie:smoke`
- `yarn workspace @happier-dev/tests providers:all:smoke`
- `yarn workspace @happier-dev/tests providers:opencode:extended`
- `yarn workspace @happier-dev/tests providers:all:extended`

Baseline updates are explicit:

- `yarn workspace @happier-dev/tests providers:opencode:smoke:update-baselines`
- `yarn workspace @happier-dev/tests providers:claude:smoke:update-baselines`
- `yarn workspace @happier-dev/tests providers:codex:smoke:update-baselines`
- `yarn workspace @happier-dev/tests providers:kilo:smoke:update-baselines`
- `yarn workspace @happier-dev/tests providers:qwen:smoke:update-baselines`
- `yarn workspace @happier-dev/tests providers:kimi:smoke:update-baselines`
- `yarn workspace @happier-dev/tests providers:auggie:smoke:update-baselines`

## Suites

- `suites/core-e2e/*`: release-gate candidates (fast + slow split)
- `suites/stress/*`: nightly/on-demand (repeat + chaos + flake classification)
- `suites/providers/*`: opt-in “real provider contract” tests (slow, may consume provider credits)

Core E2E split convention:
- `*.slow.e2e.test.ts` -> slow lane (`test:core:slow`)
- other `*.test.ts` in `suites/core-e2e` -> fast lane (`test:core:fast`)

## Artifacts & debugging

Every test case gets its own directory under `.project/logs/e2e/...` (see `src/testkit/runDir.ts`).

Common artifacts:
- `manifest.json`: per-test metadata (ports, baseUrl, session ids, env used)
- `*.events.json`: socket event timelines
- `transcript.json`: HTTP message transcript snapshots
- `server.*.log`, `cli.*.log`: stdout/stderr captures for spawned processes (when applicable)

Artifacts are written on failure by default. You can force keeping artifacts even on success:

- `HAPPIER_E2E_SAVE_ARTIFACTS=1 yarn workspace @happier-dev/tests test`

## Core e2e suite: what each test ensures

These tests always boot a real local server (local files backend) and use real sockets/HTTP.

By default, core e2e runs against embedded Postgres via `pglite`, but you can opt into other providers:

- `HAPPIER_E2E_DB_PROVIDER=pglite yarn workspace @happier-dev/tests test`
- `HAPPIER_E2E_DB_PROVIDER=sqlite yarn workspace @happier-dev/tests test`

Extended (requires an external DB URL):

- `HAPPIER_E2E_DB_PROVIDER=postgres DATABASE_URL='postgresql://...' yarn workspace @happier-dev/tests test`
- `HAPPIER_E2E_DB_PROVIDER=mysql DATABASE_URL='mysql://...' yarn workspace @happier-dev/tests test`

Local convenience (auto-provision Docker DB):

- `yarn test:e2e:core:postgres:docker`
- `yarn test:e2e:core:mysql:docker`
- `yarn test:extended-db:docker` (Postgres + MySQL, includes db contract suite)

Core e2e across *all* supported DBs (embedded + docker):

- `yarn test:e2e:core:all-db`

Shortcuts:

- `yarn test:e2e:core:embedded` (pglite + sqlite)
- `yarn test:e2e:core:docker` (postgres + mysql)

Reconnect + catch-up:
- `suites/core-e2e/reconnect.multiDevice.test.ts`: device B goes offline; messages arrive while offline; on reconnect, HTTP transcript includes all messages; no duplicate `localId`s.
- `suites/core-e2e/reconnect.multiDevice.agentMessages.test.ts`: agent (session-scoped socket) writes while UI device B is offline; on reconnect, `/v2/changes` hints + `/v1/sessions/:id/messages?afterSeq=` catch device B up to the agent messages.
- `suites/core-e2e/reconnect.midstreamStorm.test.ts`: message “storm” while device B is disconnected; on reconnect transcript converges to expected seq head; no duplicate `localId`s.
- `suites/core-e2e/changes.catchupHints.test.ts`: `/v2/changes` includes a session hint (`lastMessageSeq`) that reliably signals missing transcript data for offline devices.
- `suites/core-e2e/sessions.list.catchup.test.ts`: sessions list catch-up via `/v2/changes` + `/v2/sessions` pagination (ensures “new session appears” after reconnect).

Messages (socket + HTTP) contract/idempotency:
- `suites/core-e2e/messages.socketAck.schema.test.ts`: socket `message` ACK matches the shared schema (`@happier-dev/protocol/updates`).
- `suites/core-e2e/messages.socketAck.didWrite.test.ts`: ACK includes `didWrite=true` on first commit and `didWrite=false` on idempotent duplicates.
- `suites/core-e2e/messages.socketIdempotency.noRebroadcast.test.ts`: re-sending the same `localId` returns an ACK but must **not** broadcast a second `new-message` update.
- `suites/core-e2e/messages.socket.echoToSender.test.ts`: sender socket is skipped by default, but receives updates when `echoToSender=true`.
- `suites/core-e2e/messages.http.v2messages.emitsSocketUpdates.test.ts`: POST `/v2/sessions/:id/messages` persists and broadcasts to connected sockets.
- `suites/core-e2e/messages.http.v2messages.idempotencyKey.test.ts`: `Idempotency-Key` is treated as `localId` and duplicates do not rebroadcast.

Permissions lifecycle:
- `suites/core-e2e/permissions.lifecycle.encrypted.test.ts`: encrypted agentState permission requests are published; UI approves via encrypted RPC; offline device reconnect sees `completedRequests` converge correctly.

Provider drift detection (unit-level, no server):
- `suites/core-e2e/providers.toolSchemas.test.ts`: validates provider fixture payloads (canonical tool schemas + raw Claude envelopes).
- `suites/core-e2e/providers.baselines.test.ts`: baseline semantics (missing keys, strict keys, shape drift, `_raw` masking).
- `suites/core-e2e/providers.traceSatisfaction.test.ts`: correlation logic used while waiting for provider traces (tool-result ↔ tool-call mapping, caps).

## Stress suite: what it tests

These are intentionally slower and are meant for nightly/on-demand runs.

- `suites/stress/reconnect.repeat.test.ts`: repeats a multi-device offline/reconnect pattern `HAPPIER_E2E_REPEAT` times.
- `suites/stress/reconnect.chaos.test.ts`: seeded chaos runner that injects disconnect patterns and occasionally resends the same `localId` to simulate client retry noise.

Recommended knobs:
- `HAPPIER_E2E_REPEAT=...` (repetitions)
- `HAPPIER_E2E_SEED=...` (deterministic repro)
- `HAPPIER_E2E_FLAKE_RETRY=1` (retry once to classify flaky vs deterministic failure)

## Providers suite (opt-in)

### What the provider suite is testing

Provider tests are **contract drift** detectors:
- they run a real provider CLI through the Happier CLI
- they drive the agent by sending real session messages
- they capture a **tool-trace JSONL** file from the running agent (`HAPPIER_STACK_TOOL_TRACE_FILE`)
- they extract small “fixture” samples from that tool trace using the same code path used for curated allowlists
- they validate:
  1) invariants for the scenario (required tool calls / permission requests / side effects)
  2) schema correctness for canonicalized tools (where applicable)
  3) baseline drift (fixture keys + payload shape)

The goal is to fail loudly when a provider changes its tool formats or our normalization changes in a breaking way.

By default, `test:providers` is a fast no-op. Enable explicitly:

```bash
HAPPIER_E2E_PROVIDERS=1 HAPPIER_E2E_PROVIDER_OPENCODE=1 yarn workspace @happier-dev/tests test:providers
```

### Provider matrix runner

The entrypoint is `suites/providers/provider.matrix.test.ts`, backed by:

- `src/testkit/providers/harness/index.ts`
- `src/testkit/providers/scenarios/scenarioCatalog.ts`
- `src/testkit/providers/scenarios/scenarios.acp.ts`
- `src/testkit/providers/scenarios/scenarios.claude.ts`
- `src/testkit/providers/scenarios/scenarios.codex.ts`
- `src/testkit/providers/scenarios/scenarios.opencode.ts`

### Environment flags

- `HAPPIER_E2E_PROVIDERS=1`: enable provider contract matrix
- `HAPPIER_E2E_PROVIDER_CLAUDE=1`: enable Claude scenarios (requires a working Claude auth/config)
- `HAPPIER_E2E_PROVIDER_OPENCODE=1`: enable OpenCode scenarios
- `HAPPIER_E2E_PROVIDER_CODEX=1`: enable Codex scenarios
- `HAPPIER_E2E_PROVIDER_KILO=1`: enable Kilo scenarios
- `HAPPIER_E2E_PROVIDER_QWEN=1`: enable Qwen scenarios
- `HAPPIER_E2E_PROVIDER_KIMI=1`: enable Kimi scenarios
- `HAPPIER_E2E_PROVIDER_AUGGIE=1`: enable Auggie scenarios
- `HAPPIER_E2E_PROVIDER_WAIT_MS=...`: scenario timeout (default: 240000)
- `HAPPIER_E2E_PROVIDER_FLAKE_RETRY=1`: retry once and fail as `FLAKY` if it passes on retry
- `HAPPIER_E2E_PROVIDER_UPDATE_BASELINES=1`: write/update baseline snapshots under `packages/tests/baselines/providers/*`
- `HAPPIER_E2E_PROVIDER_STRICT_KEYS=1`: fail if scenarios observe unexpected fixture keys (default: allow extra keys for forward-compat)
- `HAPPIER_E2E_PROVIDER_YOLO_DEFAULT=1|0`: default whether provider CLI is started with `--yolo` (default: `1`)
- Scenario selection:
  - `HAPPIER_E2E_PROVIDER_SCENARIOS=execute_trace_ok,execute_error_exit_2`
  - `HAPPIER_E2E_PROVIDER_SCENARIO_TIER=smoke` (or `extended`)

Scenario IDs are source-of-truth in provider registries:
- `apps/cli/src/backends/opencode/e2e/providerScenarios.json`
- `apps/cli/src/backends/claude/e2e/providerScenarios.json`
- `apps/cli/src/backends/codex/e2e/providerScenarios.json`
- `apps/cli/src/backends/kilo/e2e/providerScenarios.json`
- `apps/cli/src/backends/qwen/e2e/providerScenarios.json`
- `apps/cli/src/backends/kimi/e2e/providerScenarios.json`
- `apps/cli/src/backends/auggie/e2e/providerScenarios.json`

Two quick examples (current at time of writing):
- OpenCode smoke: `execute_trace_ok`, `execute_error_exit_2`
- Claude smoke: `bash_echo_trace_ok`

### What the harness does (high level)

- Starts a real local `server-light`
- Creates auth via `/v1/auth`
- Creates a session with legacy encryption and writes a session-attach file
- Spawns `yarn workspace @happier-dev/cli dev <provider> --existing-session <id> ...`
- Sends encrypted prompts to `/v2/sessions/:id/messages`
- Waits for tool trace (`HAPPIER_STACK_TOOL_TRACE_FILE`)
- Extracts fixtures using `@happier-dev/cli tool:trace:extract`
- Asserts scenario invariants (fixture keys + optional workspace file checks)
- Optionally compares extracted fixture keys + payload shapes against committed baselines

### How the provider harness works (step-by-step)

Implementation: `src/testkit/providers/harness/index.ts`

1) Start server-light (selected DB provider + migrations + readiness)
2) Create a real auth token via `/v1/auth`
3) Create a session via `/v1/sessions` using **legacy encryption** (for now) and write a session attach file
4) Spawn a real agent via the Happier CLI:
   - `yarn workspace @happier-dev/cli dev <provider> --existing-session <id> [--yolo]`
5) Send the prompt via POST `/v2/sessions/:id/messages` (encrypted)
6) If YOLO is off, auto-respond to permission requests via `${sessionId}:permission` RPC
7) Wait for the tool trace file to contain the events required by the scenario (correlated by callId/tool_use_id)
8) Extract fixtures from the tool trace using:
   - `yarn workspace @happier-dev/cli tool:trace:extract --out <fixtures.json> <trace.jsonl>`
9) Validate:
   - schema validation (canonical tools where available, plus raw Claude envelope checks)
   - baseline drift (fixture keys + payload shape)
   - scenario-specific verification (e.g. file exists / contains sentinel)

### Schema validation vs baselines (both are important)

Provider drift detection uses two layers:

1) **Schema validation**
   - Implemented in `src/testkit/providers/toolSchemas/validateToolSchemas.ts`
   - Uses `@happier-dev/protocol/tools/v2` for canonical tool schemas
   - Only enforces `_happier` + per-tool schemas for protocols that actually emit canonical V2 tool envelopes today (`acp`, `codex`)
   - Claude currently records raw `tool_use`/`tool_result` blocks; we validate a minimal raw envelope for those without requiring `_happier`.

2) **Baselines**
   - Stored under `packages/tests/baselines/providers/<provider>/<scenario>.json`
   - A baseline contains:
     - `fixtureKeys`: the expected fixture key set (e.g. `acp/opencode/tool-call/Bash`)
     - `shapesByKey`: stable JSON “shape” strings for payload drift detection
   - Shapes are computed from extracted fixture example payloads (first sample per key).
   - `_raw` subtrees are intentionally treated as opaque during baseline comparisons to avoid noise from provider-added raw fields.

### What are “fixtures”?

Fixtures are extracted from the tool trace JSONL into a small JSON file:
- `v: 1`
- `examples: Record<string, ToolTraceEventV1[]>`

Keys look like:
- `<protocol>/<provider>/<kind>/<toolName?>`
  - `acp/opencode/tool-call/Bash`
  - `acp/opencode/tool-result/Bash`
  - `acp/opencode/permission-request/Edit`
  - `claude/claude/tool-call/Read`

The extractor lives in the CLI codebase and is reused here so tests match real production behavior:
- `apps/cli/src/agent/tools/trace/extractToolTraceFixtures.ts`

### Updating baselines (when and how)

Baselines should be updated when:
- a provider CLI legitimately changes tool payload shapes/keys
- we intentionally adjust the normalization pipeline (schema changes, canonical names, etc.)

To update baselines:
- run the scenario(s) with `HAPPIER_E2E_PROVIDER_UPDATE_BASELINES=1`
  - easiest: `yarn workspace @happier-dev/tests providers:opencode:smoke:update-baselines`
  - or: `HAPPIER_E2E_PROVIDER_UPDATE_BASELINES=1 HAPPIER_E2E_PROVIDERS=1 HAPPIER_E2E_PROVIDER_OPENCODE=1 yarn workspace @happier-dev/tests test:providers`

After updating:
- review the baseline JSON diff (keys and shapes)
- commit baseline updates alongside the corresponding code change

Optional strictness:
- set `HAPPIER_E2E_PROVIDER_STRICT_KEYS=1` to fail when **new** fixture keys appear (default allows extra keys for forward-compat).

## Adding a new provider

Providers are CLI-backend-owned. The test harness discovers providers by reading JSON specs from the CLI backend folders.

1) In the CLI backend folder, add:
   - `apps/cli/src/backends/<providerId>/e2e/providerSpec.json`
   - `apps/cli/src/backends/<providerId>/e2e/providerScenarios.json`
2) In the tests package, add a scenario module:
   - `packages/tests/src/testkit/providers/scenarios.<providerId>.ts`
   - Register IDs in `src/testkit/providers/scenarios/scenarioCatalog.ts` so each id maps to a scenario factory.
3) Keep scenarios small and explicit (single tool call, deterministic commands/paths).

Practical tips:
- start with `tier: smoke` scenarios only (fastest feedback)
- include `maxTraceEvents` caps in scenarios that require “exactly one tool call”
- keep prompts extremely explicit to reduce LLM/tool choice variance
