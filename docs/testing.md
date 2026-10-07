# Testing

This document records the repository-level test lane map and placement conventions. For workflow details, use the repo skill `.agents/skills/happier-testing` and the development guide at `apps/docs/content/docs/development/testing.mdx`.

## Top-level lanes

Canonical lanes:

- `yarn test` — fast unit lane across apps.
- `yarn test:import-cycles` — CLI runtime import-cycle guard, also enforced by the CLI unit lane.
- `yarn test:integration` — orchestration-heavy app integration lane.
- `yarn test:e2e:core:fast` — default local core e2e loop.
- `yarn test:e2e:core:slow` — long orchestration core e2e.
- `yarn test:e2e:ui` — Playwright UI/browser e2e exercising real UI + server + CLI/daemon flows.
- `yarn test:agents` — executable Agent runtime contracts; opt-in/flag-driven. The historical script name is retained for runner compatibility and does not refer to first-class model Providers.
- `yarn test:db-contract:docker` — server DB contract via Docker.
- `yarn test:plugin-platform:source` — current-source Plugin Platform owner contracts and public-only external-author/runtime fixtures. It never packs or installs an SDK, UI, CLI, or plugin archive.

Use the smallest relevant subset during RED/GREEN loops. Before handoff, run the touched package typecheck/build-enforcing lane and at least one broader relevant lane when shared contracts are touched.

## Choose checks by the changed contract

| Change | Focused loop | Integration boundary |
| --- | --- | --- |
| Package behavior | Existing owner test through real internal logic | Package typecheck and the affected unit/integration lane |
| Shared schema, catalog, or testkit | Shared owner tests plus an affected consumer | Relevant consumer lanes; producer-only green is insufficient |
| UI flow, layout mode, or selector | Relevant component test | Existing Playwright scenario with explicit viewport, mode, and permissions |
| Process, port, daemon, or session lifecycle | Existing process/testkit test | Owning integration lane; ephemeral ports and observed readiness, not fixed sleeps |
| CI selection, sharding, or root commands | Workflow/runner contracts and selected-file inventory | Prove complete, non-overlapping coverage and a failing final result when any required check fails |
| Installer, packaging, or release control | Canonical source contracts | Candidate-dependent smoke/update and publication checks after the actual artifact exists |

Use shared boundary fixtures and real internal owners. A changed internal export is not a reason to expand a local mock; inventory its callers and update the owning fixture once. Assert stable outcomes rather than old implementation spelling. Remove redundant or obsolete assertions only after identifying the behavior they formerly protected.

Root unit and integration commands collect failures across independent workspaces instead of stopping at the first red package. Package preparation remains a prerequisite; aggregate failure collection cannot expose behavior behind an unavailable build, database, or candidate. Do not call an unexecuted lane successful.

For broad local collection, inspect `node scripts/pipeline/run.mjs checks --profile fast --dry-run` first. For a focused rerun, use a workspace command or `checks --profile custom --custom-checks integration,typecheck --install-deps false`. Custom selection is exact, not an implicit full baseline. The checks owner collects independent failures and returns nonzero; install failure still stops dependent checks.

Local and hosted profiles share selection policy ownership in `scripts/pipeline/checks/lib/checks-profile.mjs`, but are not interchangeable matrices: local profiles preserve local toolchain coverage; hosted profiles include platform/runner jobs. Read the current command help or workflow inputs instead of assuming a local `fast` result certifies hosted `release` coverage. In 0.3, route these commands through `hstack-exec`; its public test scripts already do so.

In 0.3 development, a direct `hstack-exec` invocation from a configured Mac workspace delegates to its active primary execution host through the existing execution-host bridge. The authoritative host's native dispatcher then selects a worker using its own current configuration. Package working directories, launcher flags, explicit environment arguments and exit results survive that handoff. Explicit `--local`, already-placed children, CI and sandbox invocations retain their local paths; candidate profiles do not activate delegation.

The development launcher also accepts `--repo=/absolute/sibling/checkout` before its other options. That checkout has a separate command placement policy and mirror on the configured `mac2-linux`/`windows2-linux` subset by default; change the subset through `dev-targets placement set commands ... --repo=...`. Its Mutagen project uses the same ignore policy and `no-watch` at both ends, seeds each new session once, then crosses the existing selected-target synchronization barrier on dispatch. Admission, AUTO retries, custody and dependency freshness remain 0.3-owned; installation and UI postinstall consume the sibling's own lockfile and source, and dependency builds use its existing workspace owner. From 0.2, the optional thin `apps/stack/bin/hstack-exec` delegates when its executable 0.3 sibling exists. Without that sibling, or with `HAPPIER_ROUTED_EXECUTOR=0`, it executes locally with native stdio, exit and signal behavior. Ordinary 0.2 package scripts are not automatically rewritten; invoke them through the wrapper.

Development command placement uses the native `apps/stack/bin/hstack-exec` owner, including POSIX commands launched through `dev-targets exec auto`. CPU load and used/available memory rank reachable targets. `remote_commands.mjs` owns both workload classification and memory envelopes; its generated `native_command_policy.sh` is consumed by selection, Linux/WSL admission, and explicit local execution. Measured cli-common and Protocol dist builds use `package-dist` with the existing 6 GiB envelope: observed Linux peaks were 1,853,332 and 4,682,608 KiB respectively. Canonical runtime worker requests use `runtime-build` with an 18 GiB envelope: a successful full daemon build on Linux x64 peaked at 16,442,992 KiB of aggregate process-tree RSS. Adding at least the measured package envelope's 1,608,848 KiB of spare headroom and rounding up to whole GiB gives 18 GiB; this does not justify admitting the full workload with only 15 GiB available. Full typechecks and unmeasured builds retain the conservative 21 GiB `compilation` envelope. Focused validation and dependency installation retain their existing 6 GiB envelope, derived from the earlier approximately 5.3 GB compiler and 1.1 GB suite footprints. Dependency-incomplete typechecks do not justify lowering the conservative envelope.

Selection excludes machines whose total RAM is below the selected class's requirement. Linux/WSL admission subtracts only each live admitted job's unused reservation, `max(0, class envelope - authenticated process-tree RSS)`, from available memory: resident pages are already absent from `MemAvailable`. Missing RSS observation retains the full reservation. The existing 10% available-memory and CPU/memory pressure checks remain. Reservations remain until exit or proven-dead owner reclamation; authenticated descendants reuse their parent's reservation, and escalation replaces that owner's envelope under the admission lock while crediting its existing resident memory. Explicit `--local` bypasses remote placement and uses this same admission against local memory. Light local commands remain immediate. Diagnostics name available, required and unused reserved memory. The envelopes reserve admission headroom but do not cap a command's actual memory use. Runtime publication placement uses the retained-demand broker described below; worker pressure keeps the build remote, and only unavailable capable workers permit configured local fallback. Darwin selection applies the total-capacity filter and pressure ranking; its existing execution path has no admission queue. Native Windows command routing remains local.

In current 0.3 development source, the Linux worker fixes admission state at `/tmp/happier-heavyweight-admission-v1` and derives machine identity from the OS. Caller roots, homes, temporary mirrors and target aliases cannot create separate queues. The configured worker execution account owns that directory; unavailable or foreign-account state fails closed rather than falling back to a private root. Existing private-root live owners are observed during cutover, and authenticated legacy ancestors migrate their existing envelope on reentry. Already-loaded older launchers must drain before the new single-queue contract covers every writer.

If remote admission cannot register its state before bootstrap or payload execution, the admission owner emits an execution-qualified failure. Automatic placement excludes that worker for the existing unavailable-probe TTL and tries another configured target; an explicitly pinned invocation reports the failure without changing hosts. A started command's exit status, including 75, is authoritative and never requests replay.

In current 0.3 development, AUTO checks actual worker admission without waiting before bootstrap or payload execution. An execution-qualified busy result releases that dispatch reservation and re-evaluates the remaining pool without an unavailable-host TTL. If every usable worker is busy, the selector waits using the admission pressure-retry cadence and re-evaluates the pool; it does not fall back locally merely because workers are busy. Explicit pins retain the worker's observable admission wait. Existing already-loaded launchers are not restarted or moved by this source change.

Runtime builds prepare and upload captured source before creating a native runtime-build owner or waiter. Source-transfer PREPARE/ACK precedes, and does not replace, actual admission READY. Once source is ready, builds retain one original worker demand while native AUTO checks alternatives on that same cadence. Each alternative refreshes command capability, synchronization and load rather than reusing unavailable or load caches. A selected alternative still flushing does not stop checks of other workers; its channel stays alive and its worker is excluded from concurrent selection until actual admission or failure. Only actual READY releases the original demand. Daemon builds prefer eligible native OS/architecture workers over supported cross builders; server/web placement keeps load-based ranking. Busy native workers still allow later cross-builder admission.

Every native admission resource check reclaims owner and waiter records whose process generation is proven dead, including pressure-denied readiness probes and inherited escalation. Live records remain queued; reclamation adds no age deadline and never signals a process.

Linux/WSL waiting messages and `dev-targets status NAME` expose authenticated admission holders' class, PID, process age and approximate recent process-tree CPU use. The existing service-memory observer owns this read-only projection. Waiters reuse their preceding cadence sample; status takes a second sample at that cadence when holders exist. CPU counters have one-second resolution, unavailable evidence is reported as unknown, and zero recent CPU is not a hung verdict. Observation never imposes a holder deadline or kills work.

An explicit routed `hstack-exec --heavyweight-admission --class=... -- ...` carries its class into this same placement policy before committing to a worker. Payload flags after the delimiter do not change the envelope. Native memory observation uses the existing native process-identity owner without installed workspace dependencies, so fresh mirrors can enter admission before their first dependency bootstrap.

Stack unit roots, CLI default test homes/bins, external-hook configuration fixtures and docs-check fixtures use `scripts/testing/process/temporaryDirectories.mjs` for normal teardown. On Linux, the existing remote execution custody owner can reclaim newly marked roots after their creator, process group and explicitly bound descendants are gone. Detached children inherit `HAPPIER_TEST_TEMP_ROOTS`; inaccessible ownership observations retain the root. In current 0.3 development, its explicit `reap-temp-roots` maintenance mode also checks historical `happier-*`, `hstack-*` and `docs-check-*` directories beneath the worker's temporary directory. Linux runtime-build requests invoke the same historical scanner before compiling; ordinary command dispatch already reaps marked abandoned roots. It reclaims only account-owned, non-symlink roots whose newest descendant mtime is older than 24 hours and which no live process uses as cwd, open descriptor or mapped file; unknown process visibility retains candidates. The 24-hour margin is based on builds of at most three hours and watchers of at most two hours, and does not limit admission waits. Reclamation logs paths and allocated bytes, counting hard-linked files once. Invoke the mode through target-specific execution of `bash apps/stack/scripts/utils/dev_targets/remote_execution_custody.sh reap-temp-roots - historical-sweep`; it never signals processes.

Service placements do not exclude command hosts. Admission measures resident memory of current server/Expo process trees through their existing Stack PID state and process-generation witnesses, including standalone Expo state. It limits capacity to total RAM minus that resident memory without subtracting RSS twice from `MemAvailable`. Active builds retain their `runtime-build` class reservation. Diagnostics expose service and command reservations; no second placement list exists. A class larger than total RAM minus service reservations fails immediately with a remote-routing instruction, rather than waiting for impossible local capacity.

Fitting work can backfill a blocked queue head. There is no existing admission deadline: cumulative backfill is instead bounded by that head's existing class envelope, and stops when a candidate envelope would bridge its capacity gap. Successful admissions alone consume this allowance; failed attempts and readiness probes do not. This prevents an endless stream of small commands from starving the head, without adding a timeout or fixed job-count ceiling. Admission cannot make unavailable physical capacity appear.

Capacity exclusions are invocation-specific: healthy raw samples remain usable by focused work on smaller workers and retain the default 15-second positive probe TTL. Dependency-refresh waiting belongs to the bootstrap's workspace lock beneath the same target admission. A selected sync-flush failure retries another target before any command starts; if reachable targets have synchronization or prerequisite failures, the launcher reports an actionable error. Configured `fallback=local` applies only when no remote target is reachable, with an explicit log. Explicit `includeLocal` participation, local placement and machine-local invocations remain distinct from fallback. Exit 137 remains authoritative and reports possible OOM with the last target memory sample; it is never automatically replayed. Outbound routing requires a cwd inside the synchronized repository; explicitly local publishers and already-placed children may use temporary repositories.

Development fleet workers hosted on Windows use the managed WSL2 backend: `dev-targets add NAME --managed-wsl --outer-ssh=ALIAS --outer-ssh-config-file=PATH --dedicated-cpus=N --dedicated-memory-gib=N` provisions a named Ubuntu 24.04 guest through an authenticated Windows SSH host. The guest remains a POSIX execution target under the existing synchronization, placement and admission owners. Configure automatic placement with the guest name only; the Windows host stays a manual boundary. Capacity is explicit and `.wslconfig` applies to all WSL2 guests for that Windows user. Provisioning requires other WSL workloads stopped; forced capacity changes refuse to stop other running distributions. Guest SSH keys are pinned through the authenticated host, and a Windows startup task keeps the guest running. This backend is development-only. Verify enrollment with `doctor`, `sync`, and a command through `dev-targets exec NAME` before selecting the guest for automatic placement.

Managed guest SSH publication uses the guest alias as its multiplex identity and proxies to the outer host's loopback address. This prevents guests on different hosts with the same SSH port from sharing a connection. Foreground Stack launchers forward interruption and wait for cleanup; explicit `dev-vm exec` and ordinary delegated commands use the same guest scope owner so cancellation cleans up the guest job before closing its host transport.

In 0.3 development, `apps/stack/bin/hstack-dev-target-control` owns the native per-session synchronization barrier for automatic and exact-target commands. Queued requests may share a successful Mutagen flush only when it started after each request captured demand. A request arriving during a flush requires a later cycle, so a just-written source file cannot be admitted against an earlier scan. Each caller checks fresh exact-session health before dispatch; failed or canceled flushes cannot satisfy demand. Platforms without `flock` retain a separate flush and health check for every request.

`mutagen_runtime.mjs` owns first-cycle readiness, including its generated `native_sync_readiness.sh` projection. A clean connected idle session with both endpoints in `no-watch` and no completed cycle is `needs-flush`: eligible for selection, with the mandatory dispatch barrier establishing a completed clean cycle before any payload. An active initial scan remains `synchronizing`. Status and doctor read the same classification; startup seeding also consumes it rather than deciding independently from watch/cycle fields.

Development worker enrollment and automatic command placement attempt to disable sleep through `dev-targets power no-sleep NAME|auto`. Managed workers apply the same policy to their outer host and Linux guest. Windows disables AC/battery idle and unattended sleep, idle hibernation and lid-triggered sleep; macOS disables idle system sleep; Linux masks systemd sleep targets. Manual targets are excluded from automatic placement setup. An existing Windows machine policy enforcing zero satisfies that setting; conflicting policy remains an error. Administrator privileges are required, and denied settings are reported without blocking worker enrollment or changing placement. The explicit power command returns failure for incomplete configuration. These defaults belong to worker setup, not ordinary Happier installation on a personal computer.

In 0.3 development, Windows worker setup also installs the machine-wide `Happier-Worker-Power` task under SYSTEM, with boot and logon triggers and no execution deadline. Its administrator-protected script reapplies and verifies the same settings at boot and holds a named system power request. The existing per-user WSL task owns guest startup separately: running WSL alone does not prevent Modern Standby. The request keeps an AC-powered worker active while allowing its display to turn off. Windows limits power requests on battery and honors explicit user sleep; keep an unattended Modern Standby worker on AC. See Microsoft's [Modern Standby software preparation](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/prepare-software-for-modern-standby) and [power-request limits](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powersetrequest).

`dev-targets status NAME` reads power health for the host and guest alongside synchronization and runtime health, including effective Windows machine-policy overrides, the boot task and active power request. An unhealthy or unavailable power observation makes status fail without changing synchronization state. On macOS, incomplete idle-sleep policy reports the one-time host command `sudo pmset -a sleep 0`; Linux health requires all worker sleep targets to remain persistently masked. Power verification belongs to `worker_power.mjs`; status does not apply settings.



In 0.3 development, `apps/stack/scripts/utils/dev_targets/remote_commands.mjs` owns command classification; the native launcher consumes its generated `native_command_policy.sh` projection rather than maintaining another classifier. Native `node --test` commands receive installed-dependency readiness. Only source-proven test commands bypass workspace publication; unknown native commands retain component preparation. Stack dependency-closure publication is reserved for Stack validation, not every remote command. Default CLI/UI Vitest configurations resolve workspace source; default UI tests use the typed empty bundled-app inventory fixture, while `vitest.artifact-cache.config.ts` retains generated inventory and artifact preparation. Workspace build currentness remains owned by the dependency-closure/fingerprint path; there is no separate `prepare:build-inputs` hook.

CLI tests that copy or natively import physical public SDK packages run in `vitest.integration.config.ts`, through the same canonical workspace preparation. This includes public-authoring activation, cross-copy `PluginError`, lone-file SDK resolution, scaffold compiler/UI journeys and prepublication author installs and packs. Current-source catalog and RPC compositions that activate workspace Agent modules use `apps/cli/vitest.source.integration.config.ts`. It reuses the integration lane's resolver, aliases, includes, pool and environment, with source-only setup: native process custody is prepared, while provider declarations come from the tracked manifest projection and activation loads the real development modules. CLI unit setup uses this same source role. Compiled CLI modules, including `dist` in a source checkout, still admit distribution publication failures; packaged and unknown roles retain fail-closed inventory checks. Source imports do not satisfy fixtures that consume copied package trees or prepared CLI subprocess outputs. Temporary filesystem/process fixtures that produce their own inputs remain source-owned.

Run a source integration slice through the canonical wrapper, for example:

```bash
./apps/stack/bin/hstack-exec -- yarn --cwd apps/cli vitest:local run --config vitest.source.integration.config.ts src/api/apiMachine.preflightCatalogs.runtimeCatalog.integration.test.ts
```

The wrapper recognizes this exact CLI source configuration and retains normal validation admission and installed-dependency readiness. Other custom configurations retain workspace preparation.

In current 0.3 development, routed test commands default their dependency preparation to the existing `qa-runtime` build mode. Source-only lanes still skip workspace publication; runtime consumers prepare their required outputs, with the workspace build owner reporting any last-green fallback. Explicit `HAPPIER_WORKSPACE_BUILD_MODE` preferences remain authoritative. Build, typecheck and unknown commands retain strict preparation, and publication lifecycle entry points always force strict compilation. Runtime preparation is not compiler proof; the owning typecheck/build lanes remain required.

Collect one complete reachable failure set, fix deterministic clusters locally, then rerun affected lanes. Use one final required hosted profile for the coherent source, not a full graph per test edit. Reuse successful evidence when source, dependencies, configuration, command, and environment remain applicable. New source or a previously unreachable candidate boundary can legitimately expose another failure.

Moving-source feature QA ends at source, integration, and the loaded development
runtime. A package tarball, candidate archive, or immutable release identity is
not an extra feature-completion gate. Exact-package consumer, integrity, and
publication checks run only inside an explicitly authorized release operation
against the bytes that operation may publish.

## Voice and audio validation

The current 0.3 development QA seam is [`createVoiceQaController`](../apps/ui/sources/voice/qa/voiceQaController.ts), with default dependencies in [`voiceQaRuntimeDeps.ts`](../apps/ui/sources/voice/qa/voiceQaRuntimeDeps.ts). Text and media start modes are distinct; media delegates to the normal Voice lifecycle owner and binds the exact Home-qualified Session target. [`voiceQaDebugRuntime.ts`](../apps/ui/sources/voice/qa/voiceQaDebugRuntime.ts) defines the development/debug-runtime check. This is a development validation aid, not a second Voice runtime or a release-availability claim.

Choose the evidence boundary before running a canary:

- Text injection tests turn/tool routing and textual results; it does not prove microphone capture, speech recognition, output audio or acoustic interruption.
- A media run must prove that input audio has energy and reaches the selected active transport. A live/enabled track or elapsed microphone time is insufficient. Measure the input and observe the expected transcript/result; capture output evidence separately when claiming audible behavior.
- Browser fixture capture can use Chromium's file-backed fake microphone when the browser supports it. Verify the loaded browser's actual track rather than assuming the launch flag worked. Simulator/emulator loopback tools are environment-specific aids, not substitutes for real device acoustics.
- Exercise permissions, cancellation, interruption, transport loss and terminal cleanup through the normal host owner. Record the actual runtime, platform, account and exact Session binding; a debug route or a text canary alone does not close the normal-UI journey.
- Physical microphone/speaker quality, AEC, Bluetooth routes, native audio focus and background/lock behavior need their named device/release checks. Missing hardware evidence is reported explicitly and does not manufacture another feature-completion gate.

An approved Voice program may require a larger composed journey; use its current execution recipe for that work. Standing evidence rules live here, while program status and past host measurements remain in the program's evidence.

## Test worker budgets

Ordinary Vitest configurations share `scripts/testing/vitestWorkers.ts`: the
default maximum is `max(1, min(4, floor(availableParallelism() / 2)))`, with a
minimum of one. Development and CI use the same default. Vitest otherwise sizes
an invocation from CPU count, not current machine load; several independent
invocations can still contend, so runner-level concurrency also matters.

Set `HAPPIER_VITEST_MAX_WORKERS` to a positive integer for an explicitly sized
local or CI job. CLI worker flags remain available for individual invocations.
The UI-only `VITEST_UI_MAX_FORKS` override remains supported with its existing
six-worker ceiling; the shared override takes precedence. Explicit single-fork,
single-thread and non-parallel lanes retain their stronger isolation contract.
No test selection, assertions or coverage settings change with this budget.

## TypeScript toolchain

The repository deliberately separates the compiler from the programmatic TypeScript API:

- `@typescript/native` provides the TypeScript 7 compiler used by first-party typecheck and package-build lanes.
- `typescript` remains the TypeScript 5.9 API consumed by AST tooling and ecosystem integrations. Do not replace it with TypeScript 7 until the native release provides a stable compatible API and every consumer supports it.
- `scripts/workspaces/resolveTypeScriptCliInvocation.mjs` is the only compiler-selection owner. First-party scripts must use `runTypeScriptCli.mjs`, `buildTypeScriptPackageDist.mjs`, or that resolver directly; do not invoke a bare `tsc` shim or resolve `typescript/bin/tsc`.
- `yarn tsc ...` is defined at the repository root and in every TypeScript-owning workspace; it delegates to the shared native runner and therefore uses TypeScript 7.

CLI and UI typechecks run `tsconfig.source.json` (source) and `tsconfig.test.json`
(tests and their imported source) sequentially through that runner, including
the root source-workspace lane. Both retain the original strictness, aliases
and ambient declarations, with separate incremental caches. The original
`tsconfig.json` remains the shared full-coverage base so existing configs that
extend it retain their coverage. Repeated
`--project` arguments check every project even after compiler diagnostics and
return a nonzero result if any project fails; cancellation or launch failure
stops the sequence. These large app programs explicitly use `--singleThreaded`
to avoid retaining duplicate native checker state. Use the public package
`typecheck` entry point to check both programs, not only the source config.

Ordinary CLI builds also use one native checker. Under the existing CLI
publication lock, `apps/cli/scripts/build.mjs` reuses the source-generation path
and its compiler metadata across dev-watch builds. Each generation replaces all
copied authored inputs and removes them after use; only the incremental cache
survives. Unlocked builds keep private generations. Package dist compilation
uses one checker by default and the existing package-lock-owned compiler cache
in `scripts/workspaces/buildTypeScriptPackageDist.mjs`; an explicit
`--singleThreaded false` compiler argument opts out. Content currentness and
output promotion remain owned by the existing workspace build pipeline.

## Lane naming and placement

- App integration tests: `*.integration.test.*`, `*.integration.spec.*`, `*.real.integration.test.*`.
- Core e2e slow tests: `packages/tests/suites/core-e2e/**/*.slow.e2e.test.ts`.
- Core e2e fast tests: other `packages/tests/suites/core-e2e/**/*.test.ts`.
- UI Playwright e2e: `packages/tests/suites/ui-e2e/**/*.spec.ts`.
- Agent runtime/stress suites remain under `packages/tests/suites/agents` and `packages/tests/suites/stress`.

First-class model Provider coverage follows its owning layer rather than the historical Agent-runner name:

- protocol schemas, settings, migrations, selection, compatibility, and catalog merge: `packages/protocol/src/providers/**/*.test.ts`;
- daemon resolution, probing, discovery, materialization, and lifecycle: `apps/cli/src/providers/**/*.test.ts`;
- Provider UI/settings/model-picker behavior: `apps/ui/sources/providers/**/*.test.ts(x)`;
- built-in Provider facts: `packages/plugins/<providerId>/src/provider/contribution.test.ts`;
- cross-package and real-session behavior: `packages/tests/suites/core-e2e/**` and `packages/tests/suites/ui-e2e/**` with `.feat.providers.` naming where feature gating applies.

Security-sensitive tests must prove fail-closed ordering: a disabled feature, invalid endpoint, absent machine grant, incompatible Agent binding, or missing connection must refuse before secret lookup, network I/O, or process spawn.

Treat `test` and `test:unit` as fast lanes. Put Dockerized dependencies, multiprocess setups, external services, real network calls, or other heavy orchestration into integration/e2e/provider lanes.

When introducing or moving a lane/pattern, update all relevant places in the same change:

1. package-level scripts/config,
2. root `package.json` lane scripts,
3. CI workflow wiring.

## UI e2e authoring

- Prefer stable React Native `testID` selectors, queried in Playwright with `getByTestId(...)`.
- Treat e2e `testID`s as API surface; update specs when renaming/removing them.
- Wait for controls to be enabled before clicking.
- Click the real submit/confirm affordance.
- Do not rely on settings-sensitive shortcuts such as Enter-to-send unless the test explicitly configures that setting.
- UI e2e artifacts live under `packages/tests/.project/logs/e2e/ui-playwright/`.
- UI e2e runtime process logs live under `.project/logs/e2e/*ui-e2e*/`.

## Guardrails

- No `.skip`, `.todo`, `.only`, or hidden conditional skips in committed tests unless an explicit opt-in external probe documents the gate.
- No debugging logs in tests.
- No duplicate test intent.
- Evidence must come from trusted runners, not fabricated/manual output.
- Prefer contract-focused assertions over copy/formatting assertions.
- CLI runtime import cycles are fail-closed: update the baseline only for known debt, and keep `yarn test:import-cycles` wired through the root script and `@happier-dev/cli` unit lane so CI exercises it with CLI tests.
