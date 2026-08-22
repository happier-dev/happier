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

## Shared testkit boundaries

`packages/tests/src/testkit` is the cross-repo shared testing platform for reusable primitives only.

Canonical shared homes:
- env scope / snapshot / restore: `src/testkit/env.ts`
- tempdir / path-bin lifecycle: `src/testkit/fs/*`
- process cleanup / heartbeat / launcher helpers: `src/testkit/process/*`
- timing / wait / poll helpers: `src/testkit/timing/*`
- shared socket event capture: `src/testkit/socketEventCollector.ts` and `src/testkit/socketClient.ts`
- provider harness orchestration: `src/testkit/providers/**`

Out of scope for this package:
- UI-local render/store/router helpers
- CLI-only runtime/provider adapters
- server route/db harnesses
- stack-native `node --test` helpers

## Commands

- Core deterministic e2e: `yarn workspace @happier-dev/tests test`
- Core deterministic e2e (fast lane): `yarn workspace @happier-dev/tests test:core:fast`
- Core deterministic e2e (slow lane): `yarn workspace @happier-dev/tests test:core:slow`
- Core deterministic e2e (handoff slice): `yarn workspace @happier-dev/tests test:core:handoff`
- UI E2E (Playwright, web UI): `yarn workspace @happier-dev/tests test:ui:e2e`
- Plugin Platform exact-candidate native E2E (Maestro, gated): `yarn workspace @happier-dev/tests test:mobile:e2e:plugin-platform-candidate`
- WSREPL Lima matrix (macOS/Linux host opt-in): `yarn workspace @happier-dev/tests test:ui:e2e:wsrepl:lima -- happier-wsrepl-qa`
- Stress (configuration-driven scale harness): `yarn workspace @happier-dev/tests test:stress`
- Stress (full Compose topology): `yarn workspace @happier-dev/tests test:stress:full-compose`
- Stress Compose topology only: `yarn workspace @happier-dev/tests stress:compose:up|status|down`
- Providers (real provider CLIs, opt-in): `yarn workspace @happier-dev/tests test:agents`
- Typecheck: `yarn workspace @happier-dev/tests typecheck`

Root aliases may exist (e.g. `yarn test:e2e`), but the workspace commands above are the source of truth.

### Plugin Platform native QA

This opt-in lane admits one exact package-artifact basis at a time. Candidate
release QA consumes the daemon-selected packed SDK/Plugin UI/CLI candidate;
row-local UCX QA instead consumes an exact SDK, Plugin UI, and CLI tarball trio.
The runner rechecks package identities, materializes the exact CLI, builds the
native fixture from that exact SDK, and records the fixture archives alongside
the package identities for its one native row. Do not combine candidate and
row-local inputs.

Candidate mode retains its release-QA prerequisites: the producer must hand off
`candidate.json`, issue the literal authorization `G5_GENERATED_INPUTS_GREEN`,
and provide the existing matching packed-novel and schema-v2 Triage/GitHub/Voice
handoffs. It fails closed when any candidate prerequisite is absent:

```bash
export HAPPIER_E2E_PLUGIN_PLATFORM_CANDIDATE=/absolute/path/to/candidate.json
export HAPPIER_E2E_PLUGIN_PLATFORM_G5_AUTHORIZATION=G5_GENERATED_INPUTS_GREEN
yarn workspace @happier-dev/tests test:mobile:e2e:ios:plugin-platform-candidate
yarn workspace @happier-dev/tests test:mobile:e2e:android:plugin-platform-candidate
```

For a row-local UCX native row, provide the exact matching trio and secure
schema-v2 Triage/GitHub/Voice handoff instead. Candidate, G5, and packed-novel
inputs are not part of this mode:

```bash
export HAPPIER_E2E_UCX_NATIVE_SDK_TARBALL=/absolute/path/plugin-sdk.tgz
export HAPPIER_E2E_UCX_NATIVE_PLUGIN_UI_TARBALL=/absolute/path/plugin-ui.tgz
export HAPPIER_E2E_UCX_NATIVE_CLI_TARBALL=/absolute/path/cli.tgz
export HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_HANDOFF_MANIFEST=/absolute/path/triage-github-voice-qa.json
yarn workspace @happier-dev/tests test:mobile:e2e:ios:plugin-platform-candidate
yarn workspace @happier-dev/tests test:mobile:e2e:android:plugin-platform-candidate
```

Prerequisites are the normal connected-machine Maestro prerequisites for the
selected platform: installed native dev client, Maestro, simulator/emulator,
managed Metro support, and the repository-managed CLI author toolchain. The
combined command runs iOS and Android sequentially.

Artifact identity/materialization and both fixture generations can be checked
without launching Metro, Maestro, or a device by adding
`HAPPIER_E2E_PLUGIN_PLATFORM_PREPARE_ONLY=1` to either platform command.

After Maestro, the runner writes an observed row-local native attestation only
when it has the selected installed app/APK identity and the selected device
reports an immutable JavaScript/bundle digest that matches the row's asserted
served-bundle digest. Managed Metro no-dev full reload, the host-served bundle
URL/revision, and the app-owned module probe are supporting facts only. A URL,
host-side warm-up, or “Bundled” log alone remains insufficient. The incumbent
runner has no selected-device digest-report seam, so it records a typed block
until that report exists and matches the asserted row.

### Triage/GitHub/Voice browser handoff

The credential-bearing normal-product browser handoff is an opt-in development
QA input. Its producer accepts exactly one package-identity source: either a
complete `candidate.json`, or the exact row-local SDK, Plugin UI, and CLI
tarballs. Do not combine the two forms. The GitHub token is read only from
`HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_GITHUB_TOKEN`, never from a command-line
flag.

```bash
export HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_GITHUB_TOKEN="$GITHUB_TOKEN"
yarn workspace @happier-dev/tests prepare:plugin-platform:triage-github-voice-handoff create \
  --sdk-tarball /absolute/path/plugin-sdk.tgz \
  --plugin-ui-tarball /absolute/path/plugin-ui.tgz \
  --cli-tarball /absolute/path/cli.tgz \
  --scope-title owner/repository \
  --issue-a-title "Stable QA issue A" \
  --issue-b-title "Stable QA issue B" \
  --microphone-fixture /absolute/path/microphone.wav
```

Replace the three tarball flags with `--candidate /absolute/path/candidate.json`
for a complete candidate. Supplying `--output-root` requires a new absolute
directory outside the repository; otherwise the producer creates a private OS
temporary root. Pass its reported `triage-github-voice-qa.json` path to the
browser QA command with the matching package identity. When the aggregate
candidate-QA flow consumes that handoff, its finalizer owns marker-authorized
removal after every product consumer reaches a terminal result.

## Shared platform homes

`packages/tests/src/testkit` is the shared cross-repo testing platform. Keep app-local helpers in their owning app packages; only genuinely shared primitives belong here.

- Env overrides/snapshots: `src/testkit/env.ts`
- Temp dirs and PATH-bin helpers: `src/testkit/fs/tempDir.ts`, `src/testkit/fs/tempPathBin.ts`
- Tempdir/path-bin bridge wrappers: `src/testkit/fs/withTempDir.ts`, `src/testkit/fs/withTempPathBin.ts`
- Process cleanup / heartbeat / launcher convergence: `src/testkit/process/*`, `scripts/run-vitest-with-heartbeat.mjs`, `scripts/run-playwright-with-heartbeat.mjs`
- Shared socket event capture: `src/testkit/socketEventCollector.ts`
- Shared provider harness entrypoints: `src/testkit/providers/harness/index.ts`, `src/testkit/providers/scenarios/scenarioCatalog.ts`

FS canonical surface note:
- Prefer the handle-based APIs from `tempDir.ts` and `tempPathBin.ts` for new shared callsites.
- `withTempDir.ts` and `withTempPathBin.ts` remain compatibility bridges for older callback signatures during migration.

Socket assertion surface:
- `SocketCollector#getEvents()` and `attachSocketEventCollector(...)` both produce the same `CapturedEvent[]` contract (`connect`, `disconnect`, `connect_error`, `update`, `ephemeral`).
- Server-local fake sockets should align to that event shape instead of introducing a parallel assertion format.

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
- `suites/ui-e2e/*`: Playwright-driven browser E2E against Expo web (covers critical UI flows like auth + terminal connect)
- Native desktop E2E (Tauri MCP) is app-owned in `apps/ui/scripts/qa/**` and is invoked via `yarn test:e2e:desktop:native` (or `yarn workspace @happier-dev/tests test:desktop:native`).
- `suites/stress/*`: nightly/on-demand configuration-driven scale harness (`light`, `full-compose`, `external`)
- `suites/agents/*`: opt-in “real provider contract” tests (slow, may consume provider credits)

Core E2E split convention:
- `*.slow.e2e.test.ts` -> slow lane (`test:core:slow`)
- other `*.test.ts` in `suites/core-e2e` -> fast lane (`test:core:fast`)

## Artifacts & debugging

Every test case gets its own directory under `.project/logs/e2e/...` (see `src/testkit/runDir.ts`).

Common artifacts:
- `manifest.json`: per-test metadata and final scenario result (`status`, `endedAt`, topology, resolved config, summary pointers)
- `stress-summary.json`: per-scenario final summary (`status`, `durationMs`, resolved config, counts, latencies, failures, metrics snapshots)
- `*.events.json`: socket event timelines
- `transcript.json`: HTTP message transcript snapshots
- `server.*.log`, `cli.*.log`: stdout/stderr captures for spawned processes (when applicable)

Stress target modes:
- `light`: boots the canonical local `server-light` process via the shared process testkit
- `full-compose`: boots Postgres, Redis, Minio, scaled API/worker services, and an Nginx gateway from generated topology files inside the run directory
- `external`: attaches to `HAPPIER_STRESS_BASE_URL` and drives load against an already running target

Canonical stress env/config surface:
- `HAPPIER_STRESS_PROFILE=capacity.small|capacity.medium|capacity.large|capacity.presence-heavy|capacity.rpc-heavy|capacity.mixed-realistic`
- `HAPPIER_STRESS_TARGET_MODE=light|full-compose|external`
- `HAPPIER_STRESS_BASE_URL=https://...` for `external`
- `HAPPIER_STRESS_REPEAT`, `HAPPIER_STRESS_SEED`, `HAPPIER_STRESS_FLAKE_RETRY`
- `HAPPIER_STRESS_USERS`, `HAPPIER_STRESS_MACHINES_PER_USER`, `HAPPIER_STRESS_SESSIONS_PER_USER`
- `HAPPIER_STRESS_RPC_LISTENERS_PER_USER`, `HAPPIER_STRESS_RPC_CALLS_PER_SECOND`, `HAPPIER_STRESS_MESSAGES_PER_SECOND`
- `HAPPIER_STRESS_DURATION_MS`, `HAPPIER_STRESS_WARMUP_MS`, `HAPPIER_STRESS_COOLDOWN_MS`, `HAPPIER_STRESS_SOAK_MS`
- `HAPPIER_STRESS_RECONNECT_RATE`
- `HAPPIER_STRESS_COMPOSE_API_REPLICAS`, `HAPPIER_STRESS_COMPOSE_WORKER_REPLICAS`
- `HAPPIER_STRESS_COMPOSE_FRONT_DOOR=gateway|api-direct`
- `HAPPIER_STRESS_COMPOSE_IMAGE_BUILD_STRATEGY=if-missing|always|never`
- `HAPPIER_STRESS_COMPOSE_IMAGE_FINGERPRINT=<40-character fingerprint>` pins the existing image consumed by `never`
- `HAPPIER_STRESS_COMPOSE_REUSE_RUNNING=1` to attach to the latest running full-compose topology instead of starting a fresh one
- `HAPPIER_STRESS_COMPOSE_GATEWAY_PORT`, `HAPPIER_STRESS_COMPOSE_PG_PORT`, `HAPPIER_STRESS_COMPOSE_REDIS_PORT`
- `HAPPIER_STRESS_COMPOSE_MINIO_PORT`, `HAPPIER_STRESS_COMPOSE_MINIO_CONSOLE_PORT`
- `HAPPIER_STRESS_COMPOSE_METRICS_ENABLED`, `HAPPIER_STRESS_METRICS_SCRAPE_ENABLED`
- `HAPPIER_STRESS_ROLLING_RESTART_ENABLED`, `HAPPIER_STRESS_KILL_TARGET=api|worker|none`
- `HAPPIER_STRESS_KEEP_TOPOLOGY_ON_FAILURE=1` to preserve a failing Compose topology for inspection
- `HAPPIER_STRESS_SUMMARY_OUTPUT_PATH=/abs/path/summary.json` to mirror the final scenario summary outside the run dir
- `HAPPIER_STRESS_SOCKET_TRANSPORT=websocket|polling` for `light` and `external` modes (`full-compose` forces websocket-only synthetic clients)

`HAPPIER_STRESS_COMPOSE_FRONT_DOOR=api-direct` is currently a narrow diagnostic mode only. It publishes one API container directly on a host port and therefore is only valid with `HAPPIER_STRESS_COMPOSE_API_REPLICAS=1`. The harness now rejects multi-replica `api-direct` runs instead of producing misleading capacity data. Multi-replica front-door bypass comparisons require in-network or distributed load generation.

Legacy compatibility:
- `HAPPIER_E2E_REPEAT`, `HAPPIER_E2E_SEED`, and `HAPPIER_E2E_FLAKE_RETRY` still work, but are now resolved through the canonical stress config reader.

Artifacts are written on failure by default. On failure in `full-compose`, the harness collects diagnostics before teardown and preserves the topology when `HAPPIER_STRESS_KEEP_TOPOLOGY_ON_FAILURE=1` or `HAPPIER_E2E_SAVE_ARTIFACTS=1`.

You can force keeping artifacts even on success:

- `HAPPIER_E2E_SAVE_ARTIFACTS=1 yarn workspace @happier-dev/tests test`

Common local entrypoints:

- `yarn workspace @happier-dev/tests test:stress`
- `yarn workspace @happier-dev/tests test:stress:full-compose`
- `yarn workspace @happier-dev/tests test:stress:full-compose:reuse`
- `HAPPIER_STRESS_BASE_URL=https://stress.example.com yarn workspace @happier-dev/tests test:stress:external`

Recommended build-once / test-many full-compose loop:

1. Build and launch the canonical full-compose topology once:

```bash
HAPPIER_STRESS_COMPOSE_IMAGE_BUILD_STRATEGY=always \
yarn workspace @happier-dev/tests stress:compose:up
```

If Docker Desktop stalls during BuildKit image export on your machine, you can force the legacy builder for the one-time image build:

```bash
DOCKER_BUILDKIT=0 \
HAPPIER_STRESS_COMPOSE_IMAGE_BUILD_STRATEGY=always \
yarn workspace @happier-dev/tests stress:compose:up
```

2. Reuse that running topology across scenario runs without rebuilding the image:

```bash
HAPPIER_STRESS_TARGET_MODE=full-compose \
HAPPIER_STRESS_COMPOSE_REUSE_RUNNING=1 \
yarn workspace @happier-dev/tests test:stress:sticky-affinity
```

`HAPPIER_STRESS_COMPOSE_IMAGE_BUILD_STRATEGY` semantics:

- `always`: rebuild the canonical image before launch
- `if-missing`: reuse the canonical image only when it exists **and** matches the current runtime-input fingerprint; otherwise rebuild
- `never`: true frozen-image mode; require `HAPPIER_STRESS_COMPOSE_IMAGE_FINGERPRINT`, select that existing canonical image even if current build inputs have drifted, and fail closed unless its owner, repository-root, and fingerprint labels match. Use the `image.freshnessFingerprint` recorded in the build run's `topology/env.generated.json`.

To launch a new topology from that exact frozen image after the original topology has stopped:

```bash
HAPPIER_STRESS_COMPOSE_IMAGE_BUILD_STRATEGY=never \
HAPPIER_STRESS_COMPOSE_IMAGE_FINGERPRINT="$FROZEN_IMAGE_FINGERPRINT" \
yarn workspace @happier-dev/tests stress:compose:up
```

Set `FROZEN_IMAGE_FINGERPRINT` to the exact `image.freshnessFingerprint` recorded by the build run before invoking this command.

3. Inspect the running topology metadata at any point:

```bash
yarn workspace @happier-dev/tests stress:compose:status
```

4. Tear it down when you are finished:

```bash
yarn workspace @happier-dev/tests stress:compose:down
```

UI E2E (Playwright) notes:
- Expo web is started via `expo start --web`; if you suspect stale Metro transforms, you can opt into cache clearing with `HAPPIER_E2E_EXPO_CLEAR=1` (default is off because `--clear` can occasionally crash Metro).
- UI E2E artifacts live under `.project/logs/e2e/ui-playwright/...` and include screenshots + videos on failure.
- WSREPL Lima matrix artifacts live under `apps/stack/output/wsrepl-lima-matrix/...`; the lane entrypoint, raw harness, and Lima bootstrap helper now live in `packages/tests` (`packages/tests/scripts/run-wsrepl-lima-matrix.mjs`, `packages/tests/scripts/wsrepl-lima-matrix.sh`, `packages/tests/scripts/lima-vm.sh`). The stack copies are compatibility shims only and are excluded from the published stack package.
- Harness self-tests run via `yarn workspace @happier-dev/tests test:ui:e2e:wsrepl:lima:self`.

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

- `suites/stress/reconnect.repeat.test.ts`: repeats a multi-device offline/reconnect pattern `HAPPIER_STRESS_REPEAT` times.
- `suites/stress/reconnect.chaos.test.ts`: seeded chaos runner that injects disconnect patterns and occasionally resends the same `localId` to simulate client retry noise.
- `suites/stress/rpc.multiReplica.test.ts`: drives concurrent RPC listener registration/call churn and records routing stability under the configured topology.
- `suites/stress/rpc.duplicateListenerPolicy.test.ts`: proves duplicate listener registration remains deterministic and flags ambiguous routing policy drift.
- `suites/stress/presence.pressure.test.ts`: creates session + machine heartbeat pressure and records presence lag/ack behavior.
- `suites/stress/mixed.realistic.test.ts`: combines session creation, machine-bound sockets, transcript writes, reconnect churn, and cross-socket RPC calls into one representative full-stack workload.
- `suites/stress/stickyAffinity.validation.test.ts`: proves sticky polling continuity under correct affinity and proves degradation when affinity is removed.
- `suites/stress/reconnect.crossReplicaFailover.test.ts`: kills the connected API replica and verifies reconnect, re-auth, room rejoin, and resumed session-scoped RPC behavior on another replica.
- `suites/stress/redis.interruption.test.ts`: interrupts Redis and validates RPC, reconnect, and transcript recovery after the backplane returns.
- `suites/stress/proxy.longIdleTimeout.test.ts`: verifies an unsafe proxy idle timeout drops realtime connections while a safe timeout preserves them.
- `suites/stress/presence.workerCrashReclaim.test.ts`: crashes the worker, injects dead-consumer pending presence entries, and verifies Redis `XAUTOCLAIM` reclaim plus backlog drain after restart.
- `suites/stress/rollingRestart.test.ts`: restarts the configured service in the active topology and verifies reconnect/RPC convergence afterward.

Focused full-compose entrypoints:
- `yarn workspace @happier-dev/tests test:stress:sticky-affinity`
- `yarn workspace @happier-dev/tests test:stress:cross-replica-failover`
- `yarn workspace @happier-dev/tests test:stress:redis-interruption`
- `yarn workspace @happier-dev/tests test:stress:long-idle-proxy`
- `yarn workspace @happier-dev/tests test:stress:duplicate-listener-policy`
- `yarn workspace @happier-dev/tests test:stress:presence-worker-crash`
- `yarn workspace @happier-dev/tests test:stress:mixed-realistic`

Built-in capacity profiles:
- `capacity.small`: `1 API / 1 worker`, `250` users, `250` msg/s, `10` rpc/s
- `capacity.medium`: `2 API / 1 worker`, `500` users, `500` msg/s, `20` rpc/s
- `capacity.large`: `2 API / 2 workers`, `1000` users, `1000` msg/s, `40` rpc/s
- `capacity.presence-heavy`: `2 API / 2 workers`, `1500` users, low message/RPC pressure, intended to isolate presence/worker ceilings
- `capacity.rpc-heavy`: `2 API / 1 worker`, `40` users, `80` listeners, intended to isolate multi-replica RPC routing
- `capacity.mixed-realistic`: `2 API / 1 worker`, `250` users, `250` msg/s, `10` rpc/s, plus reconnect churn

Reference mixed-load observations from the latest `full-compose` runs:
- `1 API / 1 worker` passed `250`, `500`, `1000`, and `1500` mixed-load users with proportional `250/500/1000/1500` msg/s and `10/20/40/60` rpc/s
- at `1500` mixed-load users, the scenario sustained `30000` acknowledged messages, `1500` routed RPC calls, and `1500` concurrent machine-bound sockets without duplicate local IDs or RPC routing drift
- these runs indicate that the first current ceiling is still the high-cardinality presence/socket fan-in path rather than transcript writes or cluster RPC routing

Recommended knobs:
- `HAPPIER_STRESS_REPEAT=...` (repetitions)
- `HAPPIER_STRESS_SEED=...` (deterministic repro)
- `HAPPIER_STRESS_FLAKE_RETRY=1` (retry once to classify flaky vs deterministic failure)

Legacy compatibility:
- `HAPPIER_E2E_REPEAT`, `HAPPIER_E2E_SEED`, and `HAPPIER_E2E_FLAKE_RETRY` are still accepted through the canonical stress config reader.

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

By default, `test:agents` is a fast no-op. Enable explicitly:

```bash
HAPPIER_E2E_PROVIDERS=1 HAPPIER_E2E_PROVIDER_OPENCODE=1 yarn workspace @happier-dev/tests test:agents
```

### Provider matrix runner

The entrypoint is `suites/agents/provider.matrix.test.ts`, backed by:

- `src/testkit/providers/harness/index.ts`
- `src/testkit/providers/scenarios/scenarioCatalog.ts`
- `src/testkit/providers/scenarios/scenarios.acp.ts`
- `src/testkit/providers/scenarios/scenarios.claude.ts`
- `src/testkit/providers/scenarios/scenarios.codex.ts`
- `src/testkit/providers/scenarios/scenarios.opencode.ts`

Current Codex scope note:
- `HAPPIER_E2E_PROVIDER_CODEX=1` exercises the Codex ACP provider lane only.
- Codex app-server behavior is covered outside the provider lane in targeted CLI/plugin-runtime tests (for example `apps/cli/src/capabilities/probes/agentModesProbe.codexAppServer.test.ts`, `apps/cli/src/capabilities/probes/agentModelsProbe.codexAppServer.test.ts`, and `packages/plugins/codex/src/agent/runtime/appServer/**` tests).

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
- `packages/plugins/opencode/src/agent/e2e/providerScenarios.json`
- `packages/plugins/claude/src/agent/e2e/providerScenarios.json`
- `packages/plugins/codex/src/agent/e2e/providerScenarios.json`
- `packages/plugins/gemini/src/agent/e2e/providerScenarios.json`
- `packages/plugins/kilo/src/agent/e2e/providerScenarios.json`
- `packages/plugins/qwen/src/agent/e2e/providerScenarios.json`
- `packages/plugins/kimi/src/agent/e2e/providerScenarios.json`
- `packages/plugins/auggie/src/agent/e2e/providerScenarios.json`
- `packages/plugins/pi/src/agent/e2e/providerScenarios.json`

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
  - or: `HAPPIER_E2E_PROVIDER_UPDATE_BASELINES=1 HAPPIER_E2E_PROVIDERS=1 HAPPIER_E2E_PROVIDER_OPENCODE=1 yarn workspace @happier-dev/tests test:agents`

After updating:
- review the baseline JSON diff (keys and shapes)
- commit baseline updates alongside the corresponding code change

Optional strictness:
- set `HAPPIER_E2E_PROVIDER_STRICT_KEYS=1` to fail when **new** fixture keys appear (default allows extra keys for forward-compat).

## Adding a new provider

Providers are plugin-owned and projected into the CLI catalog. The test harness discovers providers by reading JSON specs from plugin agent e2e folders.

1) In the provider plugin folder, add:
   - `packages/plugins/<providerId>/src/agent/e2e/providerSpec.json`
   - `packages/plugins/<providerId>/src/agent/e2e/providerScenarios.json`
2) In the tests package, add a scenario module:
   - `packages/tests/src/testkit/providers/scenarios.<providerId>.ts`
   - Register IDs in `src/testkit/providers/scenarios/scenarioCatalog.ts` so each id maps to a scenario factory.
3) Keep scenarios small and explicit (single tool call, deterministic commands/paths).

Practical tips:
- start with `tier: smoke` scenarios only (fastest feedback)
- include `maxTraceEvents` caps in scenarios that require “exactly one tool call”
- keep prompts extremely explicit to reduce LLM/tool choice variance
