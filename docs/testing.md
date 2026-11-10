# Testing

This document records the repository-level test lane map and placement conventions. For workflow details, use the repo skill `.agents/skills/happier-testing` and the development guide at `apps/docs/content/docs/development/testing.mdx`.

## Top-level lanes

Canonical lanes:

- `pnpm run test` — fast unit lane across apps.
- `pnpm run test:import-cycles` — CLI runtime import-cycle guard, also enforced by the CLI unit lane.
- `pnpm run test:integration` — orchestration-heavy app integration lane.
- `pnpm run test:e2e:core:fast` — default local core e2e loop.
- `pnpm run test:e2e:core:slow` — long orchestration core e2e.
- `pnpm run test:e2e:ui` — Playwright UI/browser e2e exercising real UI + server + CLI/daemon flows.
- `pnpm run test:agents` — executable Agent runtime contracts; opt-in/flag-driven. The historical script name is retained for runner compatibility and does not refer to first-class model Providers.
- `pnpm run test:db-contract:docker` — server DB contract via Docker.
- `pnpm run test:plugin-platform:source` — current-source Plugin Platform owner contracts and public-only external-author/runtime fixtures. It never packs or installs an SDK, UI, CLI, or plugin archive.

Use the smallest relevant subset during RED/GREEN loops. Before handoff, run the touched package typecheck/build-enforcing lane and at least one broader relevant lane when shared contracts are touched.

In 0.3 development, `createLightSqliteHarness` and process-based server-light
tests share the migrated-template owner in
`packages/tests/src/testkit/process/serverLightTemplateCache.mjs`. Its typed
JavaScript boundary supports the Server compiler's package root. Each harness
copies a template into its own disposable directory before opening Prisma;
Account rows, auth initialization and file storage remain local to that harness.
Schema and migration contents determine the template key, including an explicitly
selected predecessor migration directory. The existing
`HAPPIER_E2E_SERVER_LIGHT_TEMPLATE_CACHE_DIR` override also applies to in-process
harnesses; failure-path tests that need to run migrations use a fresh cache root.

Cross-component composition tests that import another app's source use the existing `.composed.` filename segment. Preserve the lane suffix around that segment: for example, `feature.composed.test.ts` remains in a unit lane, while `feature.composed.integration.spec.ts` remains in an integration lane. Composition-only support modules use the same segment. Package TypeScript projects exclude `**/*.composed.*` so a package compile does not absorb another app's source graph; Vitest configs continue to select the files by their unit, integration, or database-contract suffix. Shared non-test contracts belong in a shared package instead of using the composition-test exclusion.

In 0.3 development, the shared finite compiler partition owner also includes
imported authored JavaScript sidecars when the package enables `allowJs`.
Dependency runtime JavaScript stays outside authored emission roots, including
ambient declarations that self-reference their package's runtime subpaths.
The public check derives these inputs without rewriting tracked membership lists.

The public UI typecheck generates typed routes with the installed Expo generator and
Metro exclusions into `apps/ui/node_modules/.cache/tsc/router.d.ts`. All finite
partitions, including CLI's referenced UI declarations, consume this compiler-owned
input; Expo's live `.expo/types/router.d.ts` remains the editor/watcher's output.
This also lets these checks run without an Expo server or a synchronized
`.expo` directory.

The SDK's native API-surface suites can run from source with
`./apps/stack/bin/hstack-exec -- node --import tsx --conditions=happier-source --test packages/plugin-sdk/scripts/apiSurfaceCli.test.mjs packages/plugin-sdk/scripts/apiSurface.test.mjs`.
That explicit source condition skips workspace package-dist preparation while
retaining compilation admission for the suites' real TypeScript programs.
Their publication fixtures prepare their own scratch-package declarations.

In 0.3 development, `pnpm --filter @happier-dev/cli run test:unit src/api/artifacts/accountArtifactStore.test.ts` forwards the file selection through the routed script chain and runs it once. Explicit runner arguments, including file and test-name filters, bypass automatic sharding and the unit lane's unrelated native checks. An unfiltered unit run retains its shard/CI-part selection, native script tests and import-cycle guard. CLI unit aliases use source-test preparation. Explicit test-file requests retain the existing validation envelope; the complete lane uses the existing compilation envelope because it executes real compiler owners. Focused compiler-consuming requests use the explicit compilation-class wrapper inside a routed outer `hstack-exec` command, never a controller-local admission implementation.

Stack unit tests also accept explicit files: `pnpm --dir apps/stack run test:unit scripts/utils/test/test_collection.test.mjs`. Paths are relative to the Stack package, or absolute. The selection uses the normal preparation, serial Node runner and isolated Stack environment; missing files, directories and integration-test files fail rather than falling back to the full suite. With no files, the command keeps its complete unit-test collection.

From the repository root, `pnpm run test:unit apps/stack/scripts/utils/test/test_collection.test.mjs` routes repository-relative or absolute files to their owning unit-test workspaces. It forwards each workspace's files to its existing test command and retains that workspace's build/check prerequisites. Unselected workspaces are skipped; duplicate paths run once. The root command rejects missing files, directories and paths outside its unit-test workspace inventory before dispatch. With no files, it retains the complete root unit-test lane.

Source-test tool requirements come from the selected package's optional
`package.json#happierSourceTestTools` array of executable names, for both direct
Vitest and package-manager requests. An absent declaration adds no prerequisite;
a malformed present declaration fails visibly. Current CLI source declares Go.
On POSIX, public source-test preparation stages current native custody through
the existing Go build owner on each invocation; Go owns source/module/build-cache
currentness. This phase uses joint package-dist admission and the existing
`cli-dist-build.lock`, so it can wait for publication, then releases both before
the test payload. Source global setup only consumes the prepared executable and
fails visibly if it is missing; it does not compile again. Windows source global
setup retains native preparation because its public wrapper has no preflight.
Artifact-consuming CLI Vitest validation retains its payload lease; source unit
runs still do not build full CLI `dist`. Generator-only checks do not acquire this CLI lease.
`createProcessCustodyFixture` copies that prepared executable rather than
starting another compiler inside a test body or hook.

In 0.3 development, package-manager workspace aliases resolve their component
through the selected workspace manifest before preparation and payload admission.
`HAPPIER_EXEC_CONFIG_PATH` is an explicit execution-policy override and must be
absolute. In 0.3 development, `hstack dev-targets path`, `show`, and configuration
mutations (including `placement set`) use that same file. An explicit `--stack`
combined with the override is rejected before reading or writing configuration;
unset the override to select a named stack. An inherited `HAPPIER_STACK_STACK`
only supplies the default stack and does not displace the override.
When selecting command execution policy, POSIX native and JavaScript
dispatch validate that file through the canonical configuration loader; a relative, missing, unreadable
or invalid override fails without default discovery, even with a warm projection.
The cached native projection must name that same canonical absolute configuration
path; a neighboring file's projection is regenerated, not borrowed. Valid explicit
configuration keeps its own remote/local fallback policy and does not require
default-discovery HOME/storage settings. Ordinary
discovery without an override retains the warm native path. Runtime/service
placement continues to read its selected Stack's configuration.
Implicit discovery also honors source-path provenance when present; older implicit
projections without that field keep their existing warm behavior until refreshed.
For example, a root `pnpm --filter @happier-dev/server run build` prepares Server's
workspace prerequisites before reserving the build's compilation capacity.
Manifest traversal follows repository-local `--cwd` and workspace references,
including lifecycle hooks: Server's prebuild and Plugin UI's public SDK
toolchain check finish before the canonical TypeScript leaf admits compilation.
Unresolved, cyclic or outside-repository script graphs retain conservative
outer admission instead of assuming that a leaf owns it.
An authenticated inherited workspace publication lease cannot wait for capacity
or a foreign producer while holding that resource. Native and in-process
preparation use the existing custody owner to
enforce this ordering. Simulated independent workers in tests use
`buildNativeAdmissionFixtureEnv` so the containing suite's real custody does not
cross their physical-worker boundary.

## Choose checks by the changed contract

### Fresh entry graph loads (0.3 development)

Run `pnpm run check:entry-loads` from the root
to load daemon, CLI, Server, UI catalog, SDK browser, Stack browser-start preflight
and cycle-sensitive Protocol schema graphs in separate fresh processes through hstack-exec AUTO. Each JSON line names the graph, source entry,
status, elapsed milliseconds and, on failure, the first module location and typed
loader error. Any failed graph makes the command exit nonzero; other graphs still run.
The existing root-script equivalent is `pnpm run exec -- node apps/stack/scripts/perf/entry-load.mjs`.
The command reads current source without rebuilding shared outputs. It reuses the
CLI source preload, Server's import-only startup path, the UI catalog's platform
harness, and the import-only phase of the SDK's browser bundle/evaluation validator. It does not start Stack
services or request a shared Metro bundle. The browser-start graph runs the real
`repo_local.mjs dev-targets browser start` wrapper with `--dry-run`, covering its
startup imports without launching Chromium. The source-plugin UI producer graph imports
`apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs` under its production
`happier-source` condition without invoking its artifact-writing main. Protocol graphs enter service placement
and managed credential delivery directly so alternate import orders remain covered.
UI catalog coverage includes the harness's
native-platform substitutions; it is not device rendering proof. Separate process
module maps are cold on every run; repeated timings can still benefit from OS caches.
The SDK's separate Action/cancellation/cleanup scenario still runs in its existing
validator suite. Existing package import-order, semantic and performance tests remain necessary for
their narrower contracts.

### Primary workload standby preparation (0.3 development)

`host.mjs` owns `hstack dev-vm primary status` and
`hstack dev-vm primary switch TARGET --dry-run`. The inspection projects the
existing execution-host profile and canonical dev-target configuration through
`utils/execution_host/primary.mjs`; it writes no primary registry or assignment.
An active Mac profile reads the mounted guest configuration through the existing
workspace-mount owner and refuses to substitute the Mac copy when that view is
unavailable. Server placement is a separate fact, never whole-workload authority.
Unknown standby lag and database replica time remain explicitly unverified.

`primary sync TARGET --source=SOURCE --home=HOME` extends the existing
`dev_targets/sync_project.mjs` owner and shared Mutagen daemon/lock. Portable
home state uses one-way-safe synchronization; generated online SQLite backups
use a non-overlapping one-way-replica session in the same project. Raw Agent
SQLite/WAL, ephemeral homes, build outputs, host-local daemon settings and
incoming SSH authorized keys are excluded. Capture does not install snapshots
over a running target's provider databases. The owner source loop is
`.project/plans/2026-09-28-systemic-deep-audit/scripts/primary-switch/owner.test.mjs`;
it exercises real Python SQLite online backup with a committed WAL writer and
the real sync owner through OS/process boundaries.

Non-dry-run switches fail before any transport or state change, even with
`--force`. SSH primary delegation, both stacks' database replication, writer
quiescence, role movement, and restore-test execution remain unimplemented. Do not
use worker-source sync readiness as proof of complete standby freshness: worker
mirrors exclude Git metadata and do not snapshot Agent SQLite databases.
The composed completion check must switch between two lane-owned throwaway
targets, preserve dirty/untracked work, move sessions through canonical handoff
between distinct Machine identities, keep the source daemon accepting new work, restore both stacks' databases
and boot its server, resume Claude Code and Codex sessions, then run the dry-run
against the real topology. It must not switch the owner's current primary.
The real work-session authority currently lives in the read-only 0.2 sibling;
its public handoff and current permission-mode/machine projection gaps require
owner authorization before the composed switch can be implemented. See the
[operator guide](../apps/docs/content/docs/hstack/dev-vm.mdx#move-the-primary).

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

The development push Gate runs each non-UI partition through `pnpm run test:gate-unit cli protocol server plugins` (or its selected subset). One Vitest instance composes the existing package-owned projects, retaining aliases, setup, exclusions and package working directories. Non-Vitest prerequisites and post-suite checks remain package-owned `test:unit:prepare` and `test:unit:checks` scripts shared with standalone commands; their failures fail the partition. `pnpm run test:plugin-workspaces` uses the same project runner. UI partitions retain their existing public wrapper and file selection. Focused Gate reruns accept `--filter=<file substring>`; they do not establish full-partition coverage.

In 0.3 development, runtime worker bootstrap, runtime validation preparation, local `hstack` bundled-workspace preflight and the Stack unit runner prepare emitted workspace prerequisites in `source-dev` mode by default. Their package compilers use the existing `package-dist` envelope, reusing an authenticated parent admission when present. Explicit strict mode and public packing/publication still check semantics. Both UI patch stages request patch-package's `--error-on-fail`, so a mixed previously patched tree reaches the existing dependency owner's pristine re-extraction and retry rather than being admitted as ready.

The development Linux heavyweight broker samples resources when an arrival has
no existing memory-waiting demand, on slot releases, after disk reclamation and
on shared recovery ticks. Further arrivals
share that observation while memory demand is queued; withdrawing an unreserved
waiter does not resample capacity. Placement and status reuse the same sample. Queued clients
block on sockets; they do not start their own process-tree census, filesystem
waiter record or catch-up poll. Relevant workspace-resource changes wake only
blocked demand that consumes those resources. Replacing the launcher affects new
invocations; already-running shells retain their parsed code.

In 0.3 development, public package typechecks resolve first-party workspace
exports to their TypeScript source through `happier-source`. The shared compiler
runner uses the canonical workspace source-export mapping, including when an
installed workspace copy is stale. Source consumers do not build dependency package-dist
outputs or acquire their publication leases. A consumer can explicitly map a workspace
export to `.d.ts`, `.d.mts` or `.d.cts` targets in its authored `paths`; these declaration
boundaries take precedence over source mappings and use the existing workspace declaration
preparation owner before compilation. The server uses this boundary for plugin-ui because
its bundled React renderer consumes a package with its own JSX compiler environment.
Other TypeScript dependency bodies are checked under
the consumer's compiler options and ambient environment; their diagnostics are
reported without filtering. JavaScript exports retain their authored source
declarations, such as `.d.mts` sidecars, rather than generated dist declarations.
Generated sources, including UI typed routes and
Server clients, remain prerequisites. Builds, shipped declarations and release
validation keep their existing compiler and publication paths.
Direct `--declaration --emitDeclarationOnly` invocations also retain their
authored package output boundary and ordered, current dependency preparation;
they are genuine emitters, not source-only checks.
Cached emitter configs resolve package self-imports through the authored source
export map, so declaration output never becomes its own input during replacement.
Authored UI/CLI compiler partitions and CLI-to-UI private-alias composition
retain their existing declaration preparation and emitted-this-invocation guard;
they do not restore package-owned environments for shared dependency bodies.

Genuine staged plugin `build:ui` prerequisites use the UI artifact compiler's
same workspace-source resolver and `happier-source` export condition. Node's
source preload alone does not select the bundler's imports. These repository
builds therefore do not require a dependency's dist to be current; the SDK's
public installed-package UI build command is unchanged.

The development-only `remote_validation_preparation.mjs --typecheck-batch`
command explicitly prepares and reads on one selected worker. Repeat
`--component-relative-dir=PATH` for consuming components, then supply `--` and
the reader command. It uses the same canonical producer transaction, collecting
the union of producer resources before native admission when publication is
needed. It publishes strict prerequisites sequentially using authenticated
inherited custody, completes each consuming component's bundled
sync, then releases publication custody before independently admitting the reader
on that same worker. A long-lived or watch reader therefore retains no producer
publication locks, and a reader failure does not retry producer preparation.
Queued controllers that still delegate a reader to the publication worker fail
before publication and must be rerun from current source.
Graph changes during preparation unwind admission before the existing
single trailing pass recollects resources. This explicit validation command is
also available for explicit multi-component validation.

In 0.3 development, `runTypeScriptCli.mjs` records each completed finite
typecheck (including its declaration-only partitions) in the ignored package-local
`node_modules/.cache/typecheck/diagnostics.json`. It prints `N new in touched
paths` against the previous completed invocation with the same authored project
set. If that local snapshot is missing, malformed or has a different project set,
it reads `.project/plans/2026-10-17-coordination/qa/baselines/<pkg>.json` in the
same snapshot format. `<pkg>` is the package directory name (for example `ui`,
`cli`, or `plugin-sdk`), or `root` for the repository root. The reference must
match the authored project set too; a usable local snapshot takes precedence.
The delta notice names `local` or `reference <path>`. Touched paths include staged
and unstaged Git changes plus untracked files under the package. Diagnostic identity is the repository-relative path, line,
column and TypeScript code; shared locations across project partitions count
once. If neither snapshot is usable it reports `baseline unavailable`.
Interrupted, partial or unrecognized compiler results retain the previous
snapshot; build, watch and introspection commands do not replace it. Snapshot
failures are reported and preserve the compiler verdict. The same diagnostic
header parser serves this observation and the root compiler-baseline check.

Referenced declaration producers may finish with ordinary diagnostics without
stopping the consumer partitions. The declaration preparation owner permits
this only when the compiler's emitted-file inventory and completed input
inventory prove that every expected declaration, including transitive inputs,
was written by that invocation and still exists. Existing files
alone do not establish freshness: missing, stale or partial output stops the
batch, as do crashes, signals and cancellation. A warm incremental pass that
reuses declarations does not meet this rule, even when every output exists;
producer diagnostics can therefore leave the previous snapshot unchanged.
A completed consumer snapshot
includes the producer diagnostics at their original locations and is labeled
`complete with producer diagnostics`. Any failed partition still makes the
command exit nonzero; an incomplete batch preserves the previous snapshot.

This delta supports lane attribution; the compiler exit status and the existing
Systemic integration owner's responsibility for package green remain unchanged.
It neither grants a diagnostic allowance nor changes the root compiler-baseline
policy. Snapshots belong to the execution host and describe its moving source
view; they do not establish freshness of consumed declarations.

After a failed emitting compilation outside the source-typecheck path, the reader checks producer records in dependency
order and appends one hint line after the compiler diagnostics for the first
noncurrent producer, with one explicit rebuild command to run from the repository
root. This runs on the worker and reaches the caller through `hstack-exec`, and
preserves the compiler's diagnostics and exit status. It checks the preparation's
build mode, so fresh unchecked development output is not mistaken for stale
content. The hint does not establish
that stale declarations caused the failure; passing checks do not run this
diagnostic or certify producer freshness. The hint itself never rebuilds or
retries. Source-consuming typechecks do not inspect dist freshness or
suggest rebuilding dependency declarations after a compiler failure.
For explicit declaration-consuming checks, the preparation command can
be used for producer repair. Typical symptoms are a missing export or property that
exists in the producer's source, and `node_modules/.cache` names in consumed
declarations. Rebuild in dependency order: Protocol, then plugin-sdk, then
plugin-ui (`pnpm --dir packages/<name> run build`, or the `--typecheck-batch`
command above on the worker that runs the reader).

Expo dev/mobile startup is source-first: its canonical UI preflight compiles only
plugin UI assets and publishes the app-owned inventory through the existing
generator. It neither waits for SDK dist publication nor consumes the CLI's
shared-dependency readiness stamp. A retained inventory permits immediate Metro
startup while that source preparation refreshes in the background. Cold startup
waits only for its source asset preparation and dependency admission. Explicit
`ensure:workspace:built --artifact` still owns package preparation.

In current 0.3 development, the Stack Expo supervisor recovers from an actual
child exit and retries failed dependency preparation, cold source preparation
and initial launches with its existing capped exponential backoff while the
Stack is running. Explicitly disabling supervision or setting its restart
attempt control to zero still disables recovery. A replacement waits for the
previous child's process completion; failed PID publication has one retry
owner. Closing the supervisor cancels replacement admission if it is still
waiting for a dependency writer. Each automatic relaunch logs
`dev Expo restarted (auto)`.
A slow Metro HTTP response does not terminate the live process:
bundling can delay `/status` under load. A live process that remains wedged
needs intervention by its lifecycle owner. Dependency reload and the existing
heap policy retain their own triggers.

In current 0.3 development, managed Expo launches request one near-limit heap
snapshot with `--heapsnapshot-near-heap-limit=1` and direct it to the owning
Stack's `logs` directory through `--diagnostic-dir`. This leaves the configured
old-space limit unchanged. The capture takes effect after the owning Stack
runner is reloaded; it does not enable an inspector or restart a running Metro.
With transformer worker threads, Node's
[memoryUsage contract](https://nodejs.org/download/release/v24.21.0/docs/api/process.html#processmemoryusage)
makes RSS process-wide while `heapUsed`, `external` and `arrayBuffers` cover only
the calling isolate. A flat main-isolate
heap therefore does not establish that transformer heaps are flat.

Managed Stack Expo children carry the explicitly selected Stack name, env-file
binding and infrastructure process kind, even when launched from a coding
session. Self-restarts publish their current PID and process-instance identity
through the existing Expo state file. Replacement uses that record and keeps a
stable port pinned; missing listener identity never grants permission to reuse
an occupied port. A failed stop reports its actual reason and any signal sent,
rather than treating every retirement failure as an ownership refusal.
When recovery is explicitly disabled or a failure is non-retryable, startup
reports a terminal stop with the failure code, observation reason and recovery
disposition; it does not schedule another admission probe.
Source edits to this supervisor take effect when its owning Stack runner is
reloaded; replacing only the Expo child leaves the parent's imported code in use.

Metro 0.83.5 passes `resolver.blockList` to its file-map crawler and watcher.
The UI config excludes package-manager shims and `.pnpm-task-run-state-v1`
directories themselves, including transient lock children, while retaining
ordinary dependency-store files. Stack runs keep Watchman disabled; Metro's
native watcher is macOS-only, so Linux uses FallbackWatcher. The root dependency
watch roots remain needed for resolved dependency files and their SHA-1 hashes.

The owner-death watchdog observes the runtime JSON without importing lifecycle
or dependency-preparation modules. Cleanup loads the canonical stop owner only
after owner death, avoiding a mix of an earlier cached dependency module and a
newly edited cleanup caller. The stop owner still authorizes the recorded owner
incarnation before terminating any process.

Package-artifact publication admits its selected plugin compiler outputs through the existing
workspace dependency build owner before the generator consumes them. This also prepares missing
`dist` on a cold AUTO replica; check-only projections and compiler-input generation do not compile
plugin packages. Existing optional-build isolation and required-plugin failure policy still apply.
Cold bundled-plugin UI builds prepare the SDK's serialized manifest input through the same
canonical manifest writer before package compilation. The existing package-input fingerprint
also binds that preparation to the admitted live or captured source basis; a changed basis uses
the existing single trailing pass instead of admitting a new manifest with an old UI graph.

Both `source-dev` and `qa-runtime` package builds compile captured inputs, so edits during compilation do not require a quiet checkout. The output record identifies the captured inputs; later edits demand a subsequent build rather than being marked current by the completed build. Ordinary strict publication builds retain their live-input drift fence.

Development startup separately admits intact last-green output through
`scripts/workspaces/ensureWorkspacePackagesBuilt.mjs`. Source server admission
checks the recorded dependency closure and its complete emitted import graph
without demanding current source fingerprints. Daemon runtime probes and Expo's
source inventory feed that same startup policy. Refresh failures preserve
availability; cold, damaged, dependency-incoherent, and strict/artifact preparation
still block. Test startup availability separately from successful refresh and
the lifecycle owner's adoption of the next build. Recovery watches derive transitive package inputs from the same
workspace graph as build admission, including compiler dependencies. Compiler
and missing-source diagnostics can wait for those corrections; wrapped Expo
errors retain their component target, and OS/configuration exits fail fast.
An explicit development-server restart that reuses a retained source generation
deploys FINAL migrations from the current server checkout before retiring the
incumbent. It never deploys the older retained catalog. Shared-database consumers
check that current catalog against their source ledger without deploying; a
failed deploy or missing migration refuses the restart. Ordinary retained startup
keeps its migration-free availability policy, and PGlite keeps its existing
exclusive-lock restart lifecycle.
Finite publication workers stream package start/done events through the
existing process transport before their terminal result, so CLI progress and
active-package failure reporting observe compilation while it is running.
Finite source QA has no
workspace-dist gate and retains its explicit restart boundary. In 0.3 development,
unchanged source web starts share a completed, validated export through the existing
source-products publisher. Owner tests distinguish a completed hit from repeated
Plugin UI/SDK preparation, Metro export and precompression, and exercise captured
membership, effective build options, damaged output, pending retention and independent
Stack serving paths. Explicit executable app-local configuration outside the captured
workspace uses private preparation rather than shared reuse.
The source-export owner also checks repeated finite exports in one context:
unchanged modules reuse persisted Metro transforms, one changed module transforms
again, and recaptured routes remain rooted in the current captured tree. The
project-root cache partition remains required because Router transforms embed it.

The Stack unit runner isolates product state and caches without dropping its executor placement or authenticated admission identity. Tests simulating a different worker isolate that worker's OS admission state and package-manager executable paths through the canonical boundary fixtures instead of sharing the real host's reservations.

In 0.3 development, `dependency_refresh.mjs` owns dependency readiness for remote
bootstrap, Stack startup, development reload and local validation. A mismatch
runs `pnpm install --frozen-lockfile` in place under one exclusive writer lock,
then checks and repairs mandatory outputs. A second writer waits and rechecks
freshness before installing. Starting commands and source CLI selection wait for
an active installer. On remote execution, finite import scopes and source launch
waits also refresh a previously admitted pnpm tree when synced dependency inputs
have changed. They use the same frozen installer before taking reader custody;
an inconsistent lockfile fails with the existing typed installation error and
is never relocked remotely. Concurrent consumers share a failed attempt too;
the failure records its input identity, so unchanged inputs keep the typed
refusal while a later synced correction can install. Cold trees retain explicit
bootstrap, and refresh-disable flags remain effective.
Command admission and long-lived source CLI execution hold
no dependency reader lease. Each entry-load graph takes the owner's shared reader
scope for its actual imports, releases it when the graph finishes, and checks
publication again before the next graph. Both
remote command entry points finish dependency and workspace preparation before
reserving the payload's heavyweight admission envelope. Preparation's compiler
leaves retain their own admission. Existing refresh-disable flags and resource
admission remain in effect.

Native Node tests derive workspace preparation from their reachable authored
imports through `nativeTestInputs.mjs`, rather than the containing app's full
dependency closure. Installed third-party imports retain dependency readiness
and ordinary validation admission without preparing unrelated workspace dist.
Built-in/source-only tests retain their smaller measured envelope; subprocess
helpers retain ordinary validation admission. First-party package imports,
including installed copies, emitted imports, incomplete graphs and opaque
module loaders retain component preparation. Local execution reports the pending
workspace-preparation phase before payload admission, then reports readiness.

Prepare dependency-input changes as one apply step. In an isolated sibling
checkout with its own dependencies, edit the workspace configuration, manifests
and patches, then run `hstack-exec --local -- pnpm install --lockfile-only`
(or `pnpm i --lockfile-only`; add `--no-frozen-lockfile` when CI requires it).
Finish and validate the lockfile there before publishing any of those inputs.
The dependency applier publishes the complete workspace/manifest/patch and
lockfile change together at one synchronization boundary, before workers can
sync or start jobs; never publish the configuration first and regenerate the
lockfile in the shared checkout afterward. Keep source synchronization paused
for that apply if it could run between the file replacements, and resume it
only after the complete input set is present. Scope synchronization operations
to the intended checkout; scratch release operations must explicitly set
`HAPPIER_STACK_SYNC_SOURCE_DIR` to the scratch source.

Lockfile-only pnpm installs are dependency-input writers: they run on the
source authority under the existing exclusive dependency writer lock, without
first preparing installed dependencies. Ordinary installs, including frozen
installs, retain their dependency bootstrap. The writer does not mark the
installed tree ready; the next dependency preparation validates the new input
set through the unchanged frozen install owner.

Install lifecycle commands default `HAPPIER_INSTALL_SCOPE` to `cli` unless the
caller chooses a scope; owners prepare other component outputs explicitly.
Native admission decisions reclaim dead owners and owner directories with an
unreadable or incomplete process identity under the existing capacity lock;
read-only memory samples do not mutate those records.

Install identity covers the lockfile, workspace YAML, registered patches,
manifest dependency fields and install lifecycle scripts, `packageManager`,
`engines`/`os`/`cpu`, and the Node ABI, platform and architecture. Unrelated
manifest fields, UI build-tool source and Prisma schemas do not trigger an
install. UI `installFreshnessInputs` belong to task-specific postinstall output
freshness: changing one reruns the affected output task. Prisma output freshness
belongs to the server's generated-client producer.

Every worker role completes UI's canonical `postinstall:real` after an install,
including forced package repairs. Readiness verifies applicable UI patches in
hoisted and app-local copies, enriched-markdown's JavaScript/WASM outputs and
mandatory postinstall assets before publishing the readiness marker. Worker
installs also prepare server-generated clients for every role before publishing
readiness. Local preparation repairs Prisma outputs when the consuming
component needs them; source server preparation does so before capture.
Healthy warm preparation only reads dependency bytes; missing
outputs use the existing output repair owners. Missing markdown artifacts are
repaired through the postinstall patch owner before its strict all-package
patch pass, without re-extracting healthy dependencies. A failed frozen install leaves
the readiness marker unchanged and raises a typed error naming the pnpm cause.
Frozen validation errors for inconsistent lockfile importers or patch
configuration leave the existing tree intact. A later linking or lifecycle
failure may already have changed installed files; correct the cause and rerun
preparation. The refresh owner never deletes or renames `node_modules`.

Agent hooks protect primary-checkout patch files and `patchedDependencies`; prepare changes in an outside worktree and hand the diff to Systemic.
Only the dependency applier sets `HAPPIER_DEPENDENCY_APPLIER=1` in its hook environment when applying the complete validated change.

In 0.3 development source, the primary dependency refresh owner can recover an
escaped edit to an already registered patch after a frozen install reports
`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`. It substitutes the locked patch digests into
its existing readiness identity to prove that registrations, manifests, runtime
and lockfile are unchanged. Each changed file must start with `diff --git`, and
`pnpm patch` must apply it to the pristine locked package before the owner runs
one script-free lockfile-only install and retries the frozen install once under
the same writer lock. The owner logs the patch paths and publishes
`patchHashRelock: { patches, at }` in the dependency generation state. Missing
admission evidence, unsupported lockfile shapes, changed dependency inputs and
invalid patches retain the ordinary failure path. Remote bootstrap and remote
installers never self-relock; they receive the primary lockfile through Mutagen
and retain their existing retry behavior. The literal edit hook remains a
preventive guard, and deliberate dependency changes still follow the applier
procedure above.

Refresh reports `stacksNeedingRestart` for running Stacks; their owners restart
them at the next boundary. Development Expo retains its Metro process and
observes dependency writes through Metro's watcher. Package metadata and link
changes recheck existing graph resolutions; they do not invalidate every
transform. Changed source files still use normal incremental transformation.
Metro's file-map batches, graph construction, dependency queries and HMR
updates share the refresh owner's finite dependency reader boundary, so they
wait while an installer changes packages. DeltaCalculator admits each executing
graph read after its current-build wait; queued HMR requests hold no reader lock.
The active read retains exclusion until it settles, then releases it before the
next queued read is admitted. The file map reconciles each changed
path from the completed tree and keeps unchanged contents out of graph updates.
The Node fallback watcher renews directory handles when installation replaces
their filesystem identities, preserving later package-file notifications.
The watcher and `/status` remain available during that wait. A failed installation
leaves its generation unpublished; new readers report the refresh owner's typed
installation or readiness failure until a successful repair.
Queued file-map work waits for the owner's next publication, including a repair
that writes no package files; it holds no dependency reader while waiting.
Already admitted readers and the installer's own prerequisite work reuse their existing
admission. Pending starts and foreign Expo processes do not veto installation.

Finite source bundles, web exports and captures compare dependency marker
identity and writer activity before construction and before publication. If the
identity changed or a writer ran between those checks, the producer discards
the candidate and rebuilds once. This protects cached artifacts without keeping
a dependency reader lock through capture or compilation. Component-owned output
preparation and package publication/resource admission retain their own owners.

JSON lock holders and waiters publish complete owner records atomically.
Wait observation ignores unrelated directory writes and existing-ticket
heartbeats; ticket joins/removals, holder changes and the existing catch-up
still drive admission and departed-owner recovery. When a queued writer blocks
a free lock, the wait diagnostic identifies that queued owner explicitly.

In current 0.3 development, the broker's memory sample uses the lower of host
`MemTotal` and the finite `memory.high`/`memory.max` limits of the launcher's
`happier-jobs.slice`. Available memory is the lower of host `MemAvailable` and
cgroup headroom (`limit - memory.current`, clamped to zero). An absent or
unlimited jobs cgroup retains host sampling. This source feeds capacity refusals,
achievable memory and reservations; callers do not apply separate limits.
Existing broker processes load this change only on replacement through the
client-owned socket succession path.

In current 0.3 development, the Linux host admission broker owns capacity and
FIFO ordering with head-floor reservation and backfill. CPU reservations share
that queue and each slot's lifetime with memory. The broker reads the OS's
available logical-core count once at startup, then admits only declared CPU
demand that fits its remaining core capacity. It does not sample CPU load or
add a CPU recovery timer. CPU-only waiters wake on existing slot/resource events
without memory/process observations. A request larger than the host receives
`HSTACK_CPU_CAPACITY`; a nonwaiting request without current room receives
`HSTACK_CPU_BUSY`.

The current command-resource catalog owns each class's CPU cost; clients send
that policy with their memory floor so retained brokers do not re-decide it
from stale catalog modules. Focused validation and native source/custody work
reserve one core and receive the existing Go/Vitest worker controls after
admission. Compilers and compound publishers reserve the host because their
runners do not establish a smaller worker bound. Managed exports reserve their
selected worker count against both resources. Explicit worker settings remain
intact and contribute declared demand; nonnumeric sizing reserves the host.
This is admission accounting, not an OS CPU quota or a measurement of other
processes. Legacy slots without a CPU declaration reserve the host until they
finish. Already-running pre-CPU brokers retain memory-only enforcement and use
minimum worker defaults for new payloads; fixed CPU enforcement requires a
successor broker. The launcher does not restart a live broker, stack or daemon.

Only a waiter whose minimum demand fits the broker's achievable memory and
fixed CPU capacity can reserve as head. Larger
waiters keep their arrival order and regain their reservation when achievable
memory recovers; non-admitted pressure must not block smaller fitting work.
While the eligible head waits,
younger fitting requests may use memory beyond its reservation, in arrival order.
The reserved part of the head's minimum floor excludes floors held by older jobs;
as those jobs release, their capacity stays reserved for the head. Younger
backfill jobs never count toward those older floors. The head is offered capacity
first as soon as it fits, without runtime estimates, aging or new tunables.
Each admitted client retains a pathname socket listener
for its payload's lifetime; closure of the broker's peer connection releases its reservation.
Waiting clients block on their control sockets without polling or process walks.
Admission uses no owner/waiter files, PID reaper, separate backfill allowance or fixed
job-count ceiling. Process and scratch custody retain their separate lifecycle owners.

In current 0.3 development, finite workspace publishers declare their existing
package/publication leases to `workspace_build_admission.mjs`; the broker
coordinates capacity with each client's nonblocking resource acquisition.
Plain and workspace demand share one broker queue. AUTO reroutes pre-dispatch capacity refusals through the eligible
pool once, then uses the existing candidate ranking to join one healthy worker's
queue. Each abandoned attempt keeps the native refusal reason visible in stderr.
An active dependency publication during preparation waits on the selected worker
through the refresh owner's completion signal, without preparing the remaining pool.
The read-only host admission sample carries the broker's cached
queued class floors across controllers. Heavy AUTO scoring includes that queued
demand against unreserved memory, using each request's canonical class floor.
Preparation-only composite commands use the same placement class and headroom
scoring without reserving capacity for their parent shell. Available CPU and
queued CPU demand travel in the existing cached broker sample; placement adds
no CPU probe or cache refresh to obtain them. Older samples without CPU fields
retain their memory ranking until the existing cache owner refreshes them.
Workers with no headroom retain their existing last-place pressure, scaled by
queued demand against total physical memory. Lightweight placement ignores it;
a later heavy command refreshes an incomplete light sample through the same
cache owner. Prerequisites, requested runtime capabilities and host load share
one SSH observation. AUTO calls with the same command, cwd and capability
requirements reuse a completed observation for the existing load-probe TTL;
explicit targets and eligible pinned-compiler requests observe afresh. The
configured unavailable-probe TTL still owns actual admission, synchronization
and pre-session SSH refusals. Older positive cache records without prerequisite
identity refresh through the same probe. Warm compiler
affinity does not override queued demand. Queue waiting retains its custody, FIFO ordering and
cancellation without repeating selection, synchronization or bootstrap. Busy
workers receive no failure TTL and do not justify local fallback. Runtime-control
alternative probes remain nonblocking while their original waiter retains custody.
For commands that require dependency preparation, the same cached host sample
also observes the canonical dependency writer. AUTO considers ready peers before
a worker whose installation is being refreshed, and logs that deferral. An
explicit target retains its wait; an entirely busy pool remains eligible for
the existing worker queue. This observation adds no failover timer or deadline.
After a capacity offer, a publisher tries its leases without waiting;
a busy attempt releases every new lease and its offered capacity while retaining
its demand and original queue order. Relevant resource changes wake blocked
demand. Only a ready lease transaction is admitted. The
generic compiler, CLI-common, SDK prepared-script, CLI readiness
and source-bundle publishers use this path; prerequisites finish outside their
publication transaction. Completed source-bundle lookup, recovery and selection
use short publication custody directly. Standalone and in-process publishers
try all declared resources without waiting, release partial acquisitions before
an event wait, and never retry an error from an entered publisher.
Package-manifest and exact-entry facts preserve placement and effective compiler
class while letting finite publishers reserve their own envelope. A lifecycle
containing a finite publisher can also defer to its canonical TypeScript leaf
after prerequisite publication. Source-typecheck runners admit their compiler
leaves without dependency publication. Raw compiler binaries and scripts
without phase-owning publishers retain outer admission with reentrant leaf
validation. Explicit command environment/cwd overrides participate
in that same policy. No second class table, admission budget or deadline is added.

Typecheck placement retains the envelope of its declared producer graph; each
compiler phase acquires its own admission. A CLI test project that references UI source therefore includes the UI
declaration producer's envelope; narrower CLI projects retain their own class.
Nested native commands reuse their containing job's socket-backed reservation.
The parent declares the composed workload's floor before it starts. A larger
nested request returns `HSTACK_NESTED_ADMISSION_CAPACITY` rather than enlarging
the parent's floor, waiting for extra capacity or creating a second slot. Joint
publication workers require their containing admission instead of creating a
second holder when the communicated identity is invalid.

Package input fingerprints use the actual package workspace's compiler-owner
scripts, not a different checkout selected by the running Stack's environment.
Explicit captured-origin remapping remains supported. A compiler-owner change
invalidates that workspace's cached output through the existing build owner;
an unrelated runtime checkout's script change does not.

Finite package captures also contain the public `hstack-exec` launcher used by
self-dispatching build scripts. Its physical repository root must remain the
captured root so manifest lookup preserves the package's declared admission
class. The public build and its lifecycle hooks still run unchanged.

The same publisher's `.happier-build-inputs.json` record can retain worker-local
output verification alongside its content digests: size, device, inode, and
nanosecond modification/change times. Matching file identity reuses the recorded
digest; changed identity verifies content again. Membership checks remain active,
including retained live outputs. Old or copied records verify once before the
publisher persists proof under its publication lease. Proof is captured from final
published paths and written atomically last; it does not change semantic output
identity or establish artifact authenticity.

Warm pnpm bootstrap checks the live pinned version before fetching an archive.
Cold archive verification and installation acquire the existing dependency-install
reservation before dependency-writer custody; the installer inherits that
reservation. UI source-test renderer compilation similarly acquires the existing
source-bundle reservation before invoking its esbuild generator. Preparation's
reservation ends before the later payload acquires its own envelope.

In 0.3 development, queued admission clients retain socket control while the
broker observes relevant workspace-resource releases. Waiting adds no per-client
custody worker, process census or catch-up timer. While resource-blocked requests
exist, one broker catch-up uses the workspace watcher's one-second cadence to
observe canonical owner status, including death without a filesystem release.
Unchanged snapshots neither reoffer work nor resample capacity; the catch-up
stops when no request is resource-blocked. JSON dependency/publication locks
reuse the workspace lock's notification mechanics while retaining their own
owner recovery and FIFO rules; heartbeat-only writes do not rescan healthy
contention. They share the workspace watcher's one-second catch-up default,
bounded by their existing acquisition and stale-owner budgets; legacy 125/250 ms
poll settings do not keep healthy owners on periodic scans.

Dependency-contention tests use fixture-owned installations and worker repository
roots. An isolated test home does not isolate a checkout-rooted dependency gate:
holding the real checkout's gate can block every other validation publisher.
Resolve the tested gate before acquiring it and keep it inside the fixture.
Captured-installation tests retain the canonical alias to that fixture-owned
installation rather than locking the shared checkout or mocking a busy bit.

The broker's workspace-resource watches filter shared lock directories to the
leases and publication-priority entries consumed by blocked requests. A
resource-busy attempt releases its partial leases and offered capacity, retaining
its original queue order. An unrelated arrival does not reoffer unchanged blocked
demand; the relevant resource change makes it runnable again. Capacity waiting
uses the broker's shared capacity observation, slot-release events and recovery
loop, without a per-waiter observer or resource walk.

In current 0.3 development, joint resource attempts and ordinary waiting
publishers share the bundle-lock owner's publication preference. A group keeps
its original age across publication contention without retaining actual leases
or capacity. The admission client retains that same scope across busy resource
attempts and withdraws it on acquisition, cancellation or exit. Dependency blockage or capacity denial suspends its preference;
retrying restores the same age. Existing priority claims retain their handoff.
A group blocked by another scope's publication lease yields its free sibling
resources to newer work. Its original age remains on the contested resource,
and resource-change observation restores preference when that blocker releases.
The group's own partial leases do not make it ineligible.
An authenticated holder of a resource needed by an older group may acquire a
free prerequisite to finish and release that resource, but may not wait while
holding it. Invalid soft-preference records grant no ordering authority and do
not make live records reapable. Observers exclude their own preference changes;
they still observe other participants and real resource changes. Already-loaded
publishers do not adopt this ordering until a new invocation loads current code.
Capacity denial is pushed from the host admission broker to the waiting client's
existing priority scope. Tooling updates to this path require a new broker process
and new queued client invocations; restarting only the broker cannot update a
client's loaded code. Admitted payloads retain their reservation across broker
replacement and are not replayed. Busy publication diagnostics identify the
blocking lease, priority claim or priority predecessor, even when the base lease
is absent.

`hstack-exec --cwd=REPO_RELATIVE_PATH -- COMMAND ...` also works with AUTO
placement. The selected target resolves the path against its repository; AUTO
retries retain it, and configured local fallback resolves it against the local
repository. Absolute paths and parent traversal are rejected. `--env` and `--tty`
still require an explicit target.

Admission refusals preserve the broker's typed reason. `dev-targets status`
consumes cached available, reserved and queued memory with active/waiting counts.
Queued commands block on sockets and can be observed through that status,
without a deciding-head PID or a per-decision kernel mutex.

Authenticated descendants may reenter their own leases and envelope. In current
0.3 development, native joint admission can wait for foreign publication resources
when the descendant retains no inherited publication lease. Each busy attempt
releases every partial acquisition before observing resource changes and reuses
the containing reservation. A descendant retaining an
inherited publication lease still refuses a foreign wait with
`HSTACK_WORKSPACE_ADMISSION_ORDER`. Raw lock-only consumers remain nonwaiting
beneath charged admission; resource-aware waits belong to native joint admission.
An inherited lease cannot queue a larger compiler or capacity request either. Declare
that producer's complete resources through joint admission before entering it.
Local prerequisite preparation likewise precedes admission. Ordinary Linux CI
keeps its compiler-admission exemption; non-Linux retains its existing execution
policy and canonical workspace leases. These changes do not replace already
loaded launchers; a stranded old invocation requires owner-controlled retirement
and reinvocation, never an unrelated Stack restart.

Routed POSIX commands default scratch beneath `tmp` in the configured worker CLI home, on the worker's disk-backed filesystem. On Linux, custody allocates a unique `hstack-*` directory there and exports it as `TMPDIR` before admission, preparation and payload execution. After the payload group stops, custody reuses its process-binding inventory to remove that command's scratch, including package-manager scratch and killed test fixtures. A surviving group, inherited `TMPDIR`/test-root binding or unavailable newer-process observation retains it. Explicit `TMPDIR` remains caller-owned and unchanged; non-Linux commands retain the shared disk-backed default. This prevents default test/build scratch from consuming RAM-backed `/tmp` quotas.

In current 0.3 development, the POSIX remote custody owner emits `[preferred-execution] custody_signal ` followed by one JSON object for each TERM/KILL it attempts. Find these lines in command stderr or the controller log that already captures it, including successful explicit cancellation through either dispatcher. The event carries UTC time sampled immediately before the signal, execution id, teardown reason (`completed`, `lifeline_eof`, `signal`, `orphan`), signal, target PID/PGID, the collected PID/start-token members and the actual syscall result (`0` for success). It is written as one complete line immediately after the syscall, with no argv or environment. Completion with no signal attempt emits no signal event. These records establish this owner's attempted signals; their absence does not identify an external signal sender or explain a historical daemon exit.

For broad local collection, inspect `node scripts/pipeline/run.mjs checks --profile fast --dry-run` first. For a focused rerun, use a workspace command or `checks --profile custom --custom-checks integration,typecheck --install-deps false`. Custom selection is exact, not an implicit full baseline. The checks owner collects independent failures and returns nonzero; install failure still stops dependent checks.

Local and hosted profiles share selection policy ownership in `scripts/pipeline/checks/lib/checks-profile.mjs`, but are not interchangeable matrices: local profiles preserve local toolchain coverage; hosted profiles include platform/runner jobs. Read the current command help or workflow inputs instead of assuming a local `fast` result certifies hosted `release` coverage. In 0.3, route these commands through `hstack-exec`; its public test scripts already do so.

In 0.3 development, a direct `hstack-exec` invocation from a configured Mac workspace delegates to its active primary execution host through the existing execution-host bridge. The authoritative host's native dispatcher then selects a worker using its own current configuration. Package working directories, launcher flags, explicit environment arguments and exit results survive that handoff. Explicit `--local`, already-placed children, CI and sandbox invocations retain their local paths; candidate profiles do not activate delegation.

In current 0.3 development, active execution-host delegation retains a running guest when only capacity or toolchain updates are pending. It warns with the pending update instead of requiring provisioning or a VM restart before Stack control and command execution, including 0.2 commands using the 0.3 controller. Each guest command still enforces its own tool requirements. Doctor continues to report full provisioning compliance; candidate execution, unavailable guest session management, creation identity drift and security configuration drift remain blocking. The existing known legacy Lima service-forward cutover exception remains transport-specific. Delegation does not apply updates or restart the guest.

The development launcher also accepts `--repo=/absolute/sibling/checkout` before its other options. That checkout has a separate command placement policy and mirror on the configured `nl3`/`windows2-linux` subset by default; change the subset through `dev-targets placement set commands ... --repo=...`. Its Mutagen project uses the same ignore policy and `no-watch` at both ends for targets without service placements, including unused targets. These targets synchronize at explicit sync or command-admission barriers. Templated Mutagen monitors select owned names in the template so temporary session absence during project replacement does not terminate observation. Service placements retain their configured hosts and roles, with source watching for service targets, but each destination uses the sibling checkout's name under that host's configured mirror parent. Linked Git worktrees can share a Stack identity; inheriting its service placement never grants two alphas the same destination. `mac-host` remains excluded from automatic command placement. The project seeds each new session once, then crosses the existing selected-target synchronization barrier on dispatch. Admission, AUTO retries, custody and dependency freshness remain 0.3-owned; installation and UI postinstall consume the sibling's own lockfile and source, and dependency builds use its existing workspace owner. From 0.2, the optional thin `apps/stack/bin/hstack-exec` delegates when its executable 0.3 sibling exists. Without that sibling, or with `HAPPIER_ROUTED_EXECUTOR=0`, it executes locally with native stdio, exit and signal behavior. Ordinary 0.2 package scripts are not automatically rewritten; invoke them through the wrapper.

In current 0.3 development, each preparation recomputes the default sibling command
pool. Only `dev-targets placement set commands --repo=ABSOLUTE_SIBLING` marks a
persisted policy as explicit (`commandExecutionExplicit: true`); an unmarked
generated policy is replaced on the next preparation. A removed target in an
explicit policy reports an unknown-target error rather than silently rerouting.

In current 0.3 development, sibling commands prepare only their selected target's replica root and retain existing producer-owned mirrors, including service watchers. Extending the project restores previously active peers without probing or bootstrapping them. Placement observes worker tools and resources through the established executor checkout; the selected source barrier then admits the replica root, seeds a new session, and flushes current source before starting the payload from the sibling's working directory. AUTO reports each selected replica-root bootstrap failure and tries another eligible target, including when a previous load probe was healthy. Root failures retain `DEV_TARGET_REPLICA_BOOTSTRAP_FAILED`; exhausted placement reports every attempted target. Explicit pins stay on their requested target. An unrelated unreachable peer receives no replica-root probe and does not block a healthy selection.

Development command placement uses the native `apps/stack/bin/hstack-exec` owner, including POSIX commands launched through `dev-targets exec auto`. CPU load and used/available memory rank reachable targets. `remote_commands.mjs` owns both workload classification and memory envelopes; its generated `native_command_policy.sh` is consumed by selection, Linux/WSL admission, and explicit local execution. Measured package dist peaks fit the existing 6 GiB `package-dist` envelope: cli-common and Protocol's earlier Linux dist peaks were 1,853,332 and 4,682,608 KiB respectively. Canonical runtime worker requests use `runtime-build` with an 18 GiB envelope: a successful full daemon build on Linux x64 peaked at 16,442,992 KiB of aggregate process-tree RSS. Adding its legacy 1,608,848 KiB unmeasured margin and rounding up to whole GiB gives 18 GiB. Two sequential public TS7 app checks on Linux ARM64 on 2026-10-09 observed largest process-tree metrics of 18,909,772 KiB for UI, 13,688,852 KiB for CLI and 14,179,616 KiB for server. Adding that same headroom and rounding up gives `compilation-ui` 20 GiB, `compilation-cli` 15 GiB and `compilation-server` 16 GiB. The owner decision applies those observations despite incomplete import graphs; they are not certified maxima and must be re-derived if a clean graph measures higher. Unscoped/mixed-package checks, commit finalizers and unmeasured builds retain the 38 GiB `compilation` envelope (the retained 2026-11-04 tree RSS peak was 38,992,620 KiB); serial projects within one package retain its package class. For UI typechecks, `resolveTypeScriptCliInvocation.mjs` selects the compiler once and the resource catalog consumes that selection: Microsoft retains `compilation-ui` at 20 GiB, while tsrs uses `compilation-ui-tsrs` at 10 GiB. The 2026-11-07 calibration sampled three live tsrs UI holders 51 times over 25 minutes: maximum live VmHWM sum 9,477,228 KiB plus measured within-holder RSS range 41,512 KiB, rounded up to whole GiB, gives 10 GiB. These are sampled live-process measurements, not certified full-lifecycle maxima; the existing capacity/OOM refusal remains the recovery path. Admission diagnostics and compiler OOMs expose insufficient headroom.

In current 0.3 development, successful sampled peaks are rounded up to whole GiB without that margin. A single explicitly selected existing Vitest file uses `focused-validation` at 1 GiB after the compiler-suite owner excludes compiler consumers and compiler setup. Directory, missing-file, option-only and whole-suite selections retain their existing class. Invalid Vitest options also retain the broader class; the payload reports their parsing error. Loaded Linux UI/CLI/server/package samples peaked below 1 GiB; repeated entry-loads exceeded 2 GiB and now use their own `entry-loads` class at 3 GiB. Ordinary `validation` remains 2 GiB (the measured deployment-protocol suite fits that envelope). The retained evidence is `.project/tmp/validation-floor-sizing-1104/measurements.json`. `dependency-install` uses 3 GiB (larger of two fresh canonical installs: 2,374,684 KiB); `native-source-test` uses 1 GiB (103,824 KiB); and `native-custody` uses 1 GiB (366,000 KiB, including the cold Go build). These sampled Linux peaks are not certified maxima or cross-platform calibration. Existing larger compilation envelopes remain unchanged.

Admission resource metadata is defined once in `apps/stack/scripts/utils/dev_targets/command_resources.mjs` and re-exported by the command-policy owner, `remote_commands.mjs`. Both its generated native memory policy and the disk owner consume this catalog; every resource class declares its disk shape. The lightweight catalog keeps placement disk checks independent of dependency bootstrap. Controller and worker admission use the same class floor, with no additional controller minimum. Existing queued requests keep the floor supplied when they were created; policy changes do not bypass queue fairness or resize admitted work.

Load policy and broker catalog changes together when adding a class: an already-running broker caches its disk owner and can refuse an unfamiliar class before payload start. Use the identity-checked broker reload owner, which preserves active slots. Changing only a numeric memory floor does not need that reload because each admission request supplies its floor.

The `source-web-export` model also rounds its recorded peaks without a blanket margin: 8 GiB at one worker, 13 GiB at eight workers and 32 GiB at 47 workers. An unspecified worker count retains the 32 GiB envelope, derived from the same recorded parallel peak. A complete finite export on Linux x64 on 2026-10-30 peaked at 11,316,692 KiB tree RSS and 11,723,928 KiB live-tree VmHWM across 105,073 samples with no unreadable processes; the larger recorded worker-count peaks remain in the model. The existing interpolation and inverse worker selection use those peaks directly through [the command policy owner](../apps/stack/scripts/utils/dev_targets/remote_commands.mjs). These estimates are not certified maxima. Source/runtime/compilation classes and `package-dist` retain their historical envelopes and unmeasured margin pending successful class calibration.

In current 0.3 development, the evidenced compiler-invoking test suites are the
exception to the focused-validation envelope. Their parent payload reserves the
existing `compilation` class when running the whole suite, when a focused
selection includes a compiler-invoking file, or when global setup compiles.
Other focused selections retain `validation`. Canonical compiler leaves reuse
the parent reservation. The suite configs and compiler-file inventory live in
[compiler_test_suites.mjs](../apps/stack/scripts/utils/dev_targets/compiler_test_suites.mjs);
plain validation suites retain `validation`, and explicit admission wrappers
retain their declared class. Package-script and declaration-wrapper expansion preserve the
prepared test target's demand, including SDK `test:source:prepared`.

Successful public typecheck measurements on Linux x64 on 2026-10-09 peaked at
10,420,624 KiB of aggregate live-tree VmHWM for Protocol and 2,777,992 KiB for
cli-common. Adding the same 1,608,848 KiB headroom gives minimum rounded
envelopes of 12 and 5 GiB. Their public scripts and compiler invocations reuse
the existing fitting classes: `runtime-build` (18 GiB) for Protocol and
`package-dist` (6 GiB) for cli-common. Plugin SDK also uses `package-dist`:
both public compiler programs ran, peaking at 4,428,896 KiB, and reported
eight TS2322 diagnostics rather than missing dependencies. Docs `types:check`
and its compiler also use `package-dist`; two runs with fresh incremental-state
files peaked at 439,544 KiB. Mixed-package and unknown checks retain
`compilation`. Dependency preparation still admits its own compiler workloads.
Canonical per-package `buildTypeScriptPackageDist.mjs -p tsconfig.json` strict
builds reuse `package-dist`, including Protocol and SDK. Successful isolated
Linux x64 strict builds on 2026-11-08 peaked at 4,732,356 and 4,358,944 KiB of
sampled tree RSS respectively, within the existing 6 GiB envelope. Their public
typechecks keep their independent classifications. Emit-only builds retain
`package-dist`. Root and cross-package project builds retain `compilation`.
Successful default-project checks for Agents, Brand, Connection Supervisor,
Peer Mediation, Peer Transport and Support also reuse `package-dist`: the
largest isolated sampled tree RSS was 4,877,652 KiB (Agents). This assignment
requires exactly one `tsconfig.json` project; alternative or combined projects
keep their existing class. Nine other package checks stopped at source
diagnostics and do not establish successful calibration peaks.
The `source-bundle` envelope is 12 GiB after a successful isolated server source
bundle on 2026-11-08 sampled 11,856,864 KiB of tree RSS, rounded up without
margin. The isolated daemon bundle also succeeded, peaking at 8,412,264 KiB.
These measurements do not recalibrate the distinct full-runtime worker.
Privacy-kit's canonical pkgroll entry, `packages/privacy-kit/scripts/build.mjs`,
also uses `package-dist`: its successful 2026-11-08 sampled tree RSS was
496,368 KiB. The same measurement sweep completed 23 package dist builds;
the largest successful peak was 3,808,016 KiB (Plugin SDK), within the existing
6 GiB envelope. Cli-common's strict run stopped at source TypeScript diagnostics
and is not a successful full-build calibration. Raw measurements are retained
under `.project/tmp/admission-floor-classes-1108/`. Unknown build entries retain
their existing class; commit coherence retains its measured 38 GiB floor.

Development synchronization uses the OpenSSH control socket selected by the synchronization owner’s generated configuration (`sync_project.mjs#prepareDevTargetOpenSsh`). Generated defaults use `ControlMaster auto` and ten idle minutes of persistence; explicit guest socket paths remain in place. In current 0.3 development, native payload execution and `buildSshWorkerArgs` use dedicated connections (`ControlMaster=no`, `ControlPath=none`), so a shared master’s keepalive expiry cannot terminate unrelated admitted payloads. Admitted payloads also set `ServerAliveInterval=0` through the canonical command policy: a temporary silence does not impose a competing lifetime on compilation or reload preparation. Connection setup policy stays configured; real transport loss still closes the custody lifeline, cancels the owned process tree and fails reload before readiness. Native dispatch creates no master, control directory or creation lock. Stack and browser forwards also remain dedicated because their owner must remove its listeners on stop without killing another session’s master. Their canonical forward builder disables SSH silence expiry (`ServerAliveInterval=0`); actual transport loss and explicit owner stop retain cancellation. Synchronization and short probes keep their separate policies. Enrollment and controller-key verification use independent handshakes rather than treating an already-authenticated master as proof of the configured key. The opt-in Linux host policies and their removal are documented in `apps/docs/content/docs/hstack/dev-targets.mdx`; neither enrollment nor ordinary dispatch applies them.

In current 0.3 development, supervisor bootstrap, readiness and worker channels use the dedicated transport from `buildSshWorkerArgs`. Stack service retirement keeps independent control transport so saturated session channels cannot block cleanup. The browser owner restores a disconnected SSH forward while its worker is alive, preserving its CDP port and reverse SOCKS binding. Failed replacements use the supervisor's existing growing retry delay and report their canonical SSH unavailability reason; authentication refusals settle without retry. Cancellation interrupts the wait and closes the owned worker and listeners. It does not restart a Stack. If an admitted worker exits cleanly without controller cancellation, the session fails with `qa-browser-worker-exited`; acquire a new browser because listener recovery cannot preserve an exited worker. `dev-targets host prepare NAME --inspect-ssh [--ssh-log-since=TIME]` is a read-only inspection mode at the same privileged host-preparation owner: it prints effective sshd limits and aggregate journal counts, without printing authentication identities or keys. Run it separately from host-setting changes; it requires existing noninteractive root/sudo access.

In current 0.3 development, a selected-target synchronization failure or an SSH-owned refusal before remote session acceptance marks that target unavailable for the configured unavailable-probe TTL. AUTO excludes it from the current command and uses the existing placement path to try another eligible target. Explicit pins stay on their requested target. Exhausted placement with `fallback=error`, and synchronization failures, return `HSTACK_EXEC_DISPATCH_REFUSED` with each attempted target and its refusal reason. Configured unreachable-only local fallback retains its existing policy. A disconnect that may follow payload execution is authoritative and is never replayed; an absent custody PID file cannot prove that work never started.

Source-replica readiness shares one known-transition-race policy between JSON consumers and native placement. A staged-file relocation collision requests the existing causal flush and requires fresh clean evidence before dispatch; permission failures, unknown errors and excluded transition evidence remain fail closed. The flush acknowledges one cycle triggered after the request; later source edits do not require a quiet period. An unresolved scan or transition problem settles as `HSTACK_SYNC_PROBLEM` with its path instead of restarting that barrier indefinitely. A subsequent command requests a new cycle. Placement surfaces the recovery diagnostics, while flush progress stays on stderr rather than contaminating its health record. Translation declaration tests keep their fixture and declaration output in private OS temporary storage, outside the synchronized source tree.

In 0.3 development, `provision.mjs` owns first-contact enrollment and explicit Linux host
preparation. Enrollment accepts missing Node/npm and prints the exact
`host prepare NAME --toolchain` next step; commands still need that toolchain. Explicit
`--toolchain` consumes the Ubuntu worker provision profile's NodeSource Node 24, npm,
Go and ripgrep setup. It verifies these tools and skips installation when they
are already usable. `--create-user=NAME [--home=/absolute/path]` installs the dedicated public key, enables
general passwordless sudo for the account, and switches the existing target's SSH user. The
default home is `/home/NAME`; `--create-user=leeroy.guest --home=/home/leeroy.guest` provides path
parity. This account policy is distinct from the existing narrow power/browser sudo grants.
Its sudoers filename uses the hex-encoded account name without dots, and the candidate connection
must pass both master-free key login and `sudo -n true` before the target changes. Existing accounts
with another home are refused, as are existing UID-zero aliases and requested homes used by another
account (including canonical path aliases), before SSH keys change. Default mirror/CLI-home paths
follow the new home, explicit paths remain.
After source synchronization, dependency bootstrap installs the root `packageManager`'s
exact, integrity-checked pnpm pin through `scripts/ci/setup-pnpm.mjs`.
CLI Vitest commands declare Go in the shared command policy, and executable preflight checks
that declaration before dependency bootstrap or payload dispatch. Repair a missing Go executable
with the same `host prepare NAME --toolchain` command; no pool-entry removal is needed.
`--tailscale [--tailscale-authkey-stdin]` installs from the official package repository, joins
when needed, and changes the existing target's endpoint to its tailnet address; the auth key
travels only through stdin. `--auto-updates` enables unattended security upgrades without
automatic reboot on Ubuntu. The [worker guide's fresh-host recipe](../apps/docs/content/docs/hstack/dev-targets.mdx#bring-up-a-fresh-linux-server)
then invokes the existing QA tooling owner and exact-target executor before selecting placement.

For existing workers with only the older narrow sudo grant, explicitly refresh it with
`hstack dev-targets host prepare NAME --passwordless-sudo --passwordless-provisioning`
before `hstack dev-targets qa setup NAME`. The browser installer uses
the discovered absolute Node executable and npm CLI entry inside sudo for the constrained
global agent-browser installation; arbitrary elevated environment variables are not granted.
QA setup does not broaden privileges automatically; full `--create-user` grants need no refresh.

`--lockdown[=tailscale-only|ssh-public]` owns UFW default-deny incoming policy and SSH password,
keyboard-interactive, and password-based root-login restrictions. Tailscale-only is the default
and ssh-public additionally permits public 22/tcp. Both require installed UFW, Tailscale up,
and an actual fresh tailnet-addressed key connection. The same SSH policy owner adopts the earlier
`40-happier-no-password.conf` beside its fleet SSH configuration. Before every SSH-server/firewall policy mutation,
preparation requires a dedicated-key probe with `ControlMaster=no` and `ControlPath=none`,
arms five-minute automatic rollback, validates SSH configuration, and cancels rollback only
after a fresh post-change key login. A password-authenticated master is not key evidence.
The observed empty `authorized_keys` was caused by the orchestrator's `SSH_ASKPASS` helper:
its inner SSH command consumed the outer command's stdin; adding `ssh -n` fixed that input loss.
The enrollment defect was separately allowing a password-authenticated master to satisfy its
dedicated-key probe. Recovery restores the key through password enrollment or an independent administrator
or provider console, then proves a master-free key login before applying restrictions.

Validate missing-toolchain enrollment, check-first repeated preparation, account/home
changes, secret transport, Tailscale-only refusal, independent key probes and rollback
arming/cancellation. Live proof uses the enrolled host: verify key-only tailnet login, public
22/tcp closure from a non-tailnet path when available (otherwise label UFW/listening-socket
evidence as the narrower observation), run QA setup and exact-target execution, then use existing
command and QA placement owners. Script generation and green unit tests alone do not establish
live host readiness. These host changes are opt-in, never ordinary dispatch side effects.
Ordinary unmanaged `add --host` does not apply power policy; explicit `--managed-lima` and
`--managed-wsl` enrollment still provisions the whole guest and its existing power policy.
`service_placement.mjs#DEFAULT_QA_TARGET_NAMES` owns the approved default browser pool and new QA creation
projection consumed by `stack_commands.mjs`; current 0.3 development uses `nl3`, then `nl1`.
Explicit candidate pools stay exact;
creation defaults never retrofit existing Machine pins. Browser placement ranks the pool for its
own lifetime and does not move the daemon. The implicit browser pool includes only candidates
registered in that consumer's existing target registry, so registries predating either worker still work.
An empty implicit pool and an unknown explicitly named target fail without local browser fallback.

In current 0.3 development, an unplaced package-script command whose entire payload directly invokes `hstack-exec --script=...`, without local pre/post hooks, reaches that script before the outer launcher selects a host or reserves memory. The package manifest owns this delegation, including `--dir` and pnpm workspace filters; there is no separate list of routed script names. The script's dispatcher owns placement and admission on the executing host. Binary runners, implementation scripts, already-placed commands and genuine local payloads keep their existing admission envelopes.

On the Linux controller, explicit `--local` heavyweight compilation (including package-dist and runtime-build) refuses by default and points to AUTO. A caller can explicitly authorize `--local --allow-local-compilation`; this changes placement only and retains the same class admission used by workers, even under CI. Deferred finite producers and compiler leaves inherit that admission requirement rather than reserving their package-manager parent. Already-placed workers do not require the controller override. Light local commands remain immediate. Ordinary automatic CI execution retains its existing exemption.

Linux AUTO keeps heavyweight commands, including compilation and validation, in the configured remote command pool even with `includeLocal: true`. The controller does not compete by load for these classes; lightweight commands still honor `includeLocal`. Busy workers retain the existing remote admission/reselection flow. Explicit local placement and configured local fallback when workers are unreachable retain their existing admission rules; this does not require a per-session execution config.

Heavyweight ranking adds normalized CPU load to the selected class envelope divided by observed unreserved memory (available memory on Darwin). This compares actual headroom for the command rather than each worker's percentage of free RAM, so larger workers are not penalized solely for having more total memory. Existing class-capacity checks, live admission, active same-project follower preference and runtime platform preferences still apply.

In current 0.3 development, placement derives nested demand from the canonical package script and lifecycle graph, including supported shell command sequences with login flags. Runtime validation placement also reads the workspace preparation producer's component scope and build graph. Its placement envelope covers the strongest required phase; preparation and the payload retain their own admission classes and publication leases.

Selection excludes machines whose total RAM is below the selected class's requirement. Linux AUTO also excludes a host when the broker's observed achievable memory is below that requirement; admitted resident pages remain included in achievable memory, so admitted pressure can still queue. Linux admission subtracts only each admitted job's unused reservation, `max(0, class floor - observed process-tree PSS)`, from available memory: resident pages are already absent from `MemAvailable`. Missing proportional-memory evidence retains the full reservation. There is no additional guessed available-memory percentage, PSI or CPU-load denial. Reservations follow client-held socket witnesses. Nested commands reuse their containing job's fixed floor; a larger nested request refuses rather than enlarging that floor or taking a second slot. Explicit `--local` bypasses remote placement and uses this same admission against local memory. Light local commands remain immediate. `dev-targets status` consumes cached available, reserved and queued memory with active/waiting counts. The floors reserve admission headroom but do not cap a command's actual memory use. Runtime publication placement uses the retained-demand broker described below; busy admission keeps the build remote, and only unavailable capable workers permit configured local fallback. Darwin selection applies the total-capacity filter and load ranking; its existing execution path has no admission queue. Native Windows command routing remains local.

In current 0.3 development source, only a request exceeding total physical memory is permanently infeasible and emits `HSTACK_ADMISSION_CAPACITY:<executionId>` before payload execution. AUTO excludes that worker for this invocation and re-evaluates the pool; an explicit pin returns the refusal. A physically fitting request with insufficient current unreserved memory is busy or waits. Achievable memory determines the current reserving head and AUTO placement eligibility, never permanent capacity. A waiting request above achievable memory keeps waiting without reserving a head floor until memory recovers. The broker samples the first arrival without existing memory demand, slot releases, disk reclamation and shared recovery ticks; later queued arrivals and cached placement/status reads reuse that observation.

For a `sh`/`bash` batch, placement also considers known producer commands in its
static prefix, including multiline inline bodies and repository script files.
Blank lines, comments and inert strict-mode options do not hide that demand.
Inspection stops at unsupported syntax or commands whose state or demand is
unknown; it does not infer later producers across `cd`, `export` or positional
argument changes. The known prefix's largest class filters workers before any
payload starts. This changes placement only: the shell text, each producer's
admission and a started payload's authoritative exit remain unchanged.

In current 0.3 development source, the canonical Linux observer uses `/proc/<pid>/smaps_rollup` PSS for admitted trees so shared pages contribute each process's share. Service/browser memory is diagnostic: its resident pages already reduce OS `MemAvailable`, and its census never supplies another capacity deduction. Service diagnostics can report a summed RSS upper bound or an explicit RSS fallback; admission credits only observed PSS and retains the full reservation when that evidence is unavailable. Process metadata is observed once for the executing account, without per-PID subprocesses. Historical RSS peak measurements above remain measurements of the original runs.

In current 0.3 development source, the Linux worker fixes admission state at `/tmp/happier-heavyweight-admission-v3` and derives machine identity from the OS. The root's protocol revision must change when waiter/owner semantics change, keeping incompatible launchers in separate queues. Revision 3 adds lease availability to queued publishers so a lease-blocked head yields priority. Caller roots, homes, temporary mirrors and target aliases share the queue for their revision. The configured worker execution account owns that directory; unavailable or foreign-account state fails closed rather than falling back to a private root. Authenticated live owners in other roots retain their unused memory reservations through process-tree observation, and authenticated ancestors reuse their existing envelope on reentry. Queue heads identify themselves by pid and kernel start token rather than waiter path. Already-loaded older launchers remain in their original queue and require owner-controlled reinvocation if stranded; atomic source replacement cannot update their parsed program.

If remote admission cannot register its state before payload execution, the admission owner emits an execution-qualified failure. Automatic placement excludes that worker for the existing unavailable-probe TTL and tries another configured target; an explicitly pinned invocation reports the failure without changing hosts. Preparation failures and a started payload's exit status, including 75, are authoritative and never request replay.

In current 0.3 development, AUTO checks dispatcher-owned payload admission without waiting after preparation and before payload execution. An execution-qualified busy result releases that dispatch reservation and re-evaluates the remaining pool without an unavailable-host TTL. After the eligible-pool sweep, an entirely busy pool retains one broker request, its queue order and cancellation; it does not fall back locally merely because workers are busy. Heavy Linux candidates rank using the broker's cached unreserved memory budget (OS available memory less unused admitted reservations) and queued class floors; a budget below the command's class floor ranks behind fitting workers. Explicit pins retain the worker's observable admission wait. Existing already-loaded launchers are not restarted or moved by this source change.

POSIX compilation-class dispatch in 0.3 development uses current resource ranking,
not the most recently completed worker. An in-flight same-project typecheck
follower may join its admissible leader's worker; a completed check publishes no
placement affinity. Dispatcher-certified busy admission falls back to ordinary
pool selection, including bare canonical TypeScript commands. Finite publishers and the compiler leaves of producer-containing
lifecycles instead wait through their own admission transaction on the selected
host, without an outer reservation across prerequisite production. Each invocation completes its own causal synchronization
barrier and runs through the existing heavyweight admission. The native compiler
remains authoritative for incremental currentness. There is no input-equality
scan, shared in-flight result or completed-check cache.

Only AUTO candidate placement uses the derived seven-second SSH connect allowance:
the canonical 15-second probe-sharing default divided across the existing two
read-only connection attempts, rounded down to OpenSSH's integral seconds.
Configured cache reuse does not enlarge this fast-skip allowance. Exact-target
observations, post-selection recovery, payload dispatch and cancellation inherit
the worker's configured SSH connect and keepalive budgets.

The root `build:packages` coordinator follows this producer-owned admission path.
With configured dev targets, it dispatches the requested workspace graph to each
target through the existing executor before returning. Each target runs the same
host-local fingerprint and publication owner; ignored `dist` bytes are never copied
between hosts. Without configured targets, preparation remains host-local.
Its existing workspace graph prepares transitive producers through their joint
publication-lease and capacity owner. Dispatch retains the compilation placement
envelope without reserving capacity around the coordinator, so a foreign producer
lease can settle before admission. Admitted descendants retaining publication
leases still cannot wait for foreign publication leases.

Remote development service readiness and QA-browser forward readiness have no
automatic overall startup deadline. They follow their owning process/user
cancellation and exit lifecycle. Explicit server readiness uses the canonical
server timeout parser; Expo and daemon readiness have no separate timeout
environment setting. Mutagen project mutation still uses its canonical
exclusive lock, without a competing acquisition deadline. Remote cancellation
confirmation similarly has no separate ten-second command cutoff.

Fresh remote service ports use the target host's socket selector after native
retirement, rather than controller-generated port pools. Explicit and live
retained routes keep precedence; saved server ports are reused when free, and
an occupied saved port reports the replacement through the existing allocation
state. Expo selection excludes the target's server/reverse-forward port.
A cold server or Expo worker that exits before readiness releases its unverified
forward after native absence is confirmed, then asks the selector again.

Readiness failures and target lifecycle recovery share the existing growing
retry delay. A failed shared workspace preparation remains the current result
until the registered daemon reload watcher starts another build; target recovery
does not create a second build timer. The same producer serves remote-only and
local-and-remote daemon placement. Closing the target or losing its transport
can interrupt its preparation wait without cancelling another consumer's build.

Source daemon readiness consumes typed sign-in/running facts on the worker's
existing stdout channel, without repeated readiness SSH commands. Retained
attachment and transport reattachment keep one initial probe, then consume the
same facts. The worker projection and attach probe share the native auth/PID
reader. Startup and attachment use the same scoped runtime environment prelude;
attachment does not require inherited controller environment variables. Server
HTTP and Expo Metro polling remain with their existing owners.

Pending sign-in observes the canonical authentication paths. A controller login
wakes its pending transfer, and native login wakes the worker readiness fact even
when an already-running daemon has no new runtime-state publication. These
subscriptions end when readiness settles or its owning target is cancelled.

In current 0.3 development source, browser workers retain their signal handlers until their detached agent-browser session and temporary profile are closed. Controller loss follows the existing stdin lifeline; browser custody sends `close` through the existing control channel and awaits that cleanup rather than applying the generic two-second group cancellation. Stack stop retires exact Stack-name/env-file/browser-kind bindings locally and on configured POSIX targets, even without runtime state. It closes workers before sweeping remaining orphaned browser processes. The remote retirement entry loads only dependency-free process leaves, using Node’s built-in type stripping; it does not synchronize the mirror or enter dependency publication. An unavailable target leaves browser retirement unconfirmed, reports the non-blocking warning `browser_cleanup_unreachable:<target>`, and allows stop to proceed. A later ordinary sweep reaps its marked browsers once the target is reachable again. A contacted target reporting browser cleanup failure or invalid cleanup confirmation still prevents finalization. This does not authorize another Stack's processes or a controller-local fallback.

An agent-browser CLI session attached to the returned CDP endpoint runs a separate daemon on the controller. Its caller must run `agent-browser --session <lane-session> close` in its cleanup path before ending the browser owner handle, including when QA fails. Worker or Stack retirement does not own that unmarked controller daemon. Agent-browser 0.34.0 exempts attached browsers from its default idle shutdown, and a disconnected browser can leave cached page counts in `session info`; neither a stopped worker nor that page count proves the controller daemon has exited. Close only the caller's named session and confirm its recorded PID exits; never use `close --all` in the shared checkout.

Remote Stack retirement in current 0.3 development uses the canonical trusted-process lifecycle owner when a runtime record survives a reboot; a retained file does not prove its recorded processes are alive. The existing legacy Expo-state probe still blocks retirement while a recorded Expo process survives. After a failed or interrupted stop, including one with no exit status, a fresh absence probe can confirm retirement. Surviving processes or unreadable membership remain unconfirmed and block completion.

In current 0.3 development, runtime builds use native AUTO to select and synchronize an eligible worker from the command pool. Daemon builds prefer eligible native OS/architecture workers over supported cross builders; server/web placement keeps load-based ranking. A capacity wait retains the selected worker's native queue position without spawning alternative launchers. The launcher forwards `--control-stdin` directly: the admitted worker emits READY before the controller sends its build request, and a started worker's result never triggers payload replay. Explicit local placement and unavailable-target local fallback use the same native admission owner.

In current 0.3 development, `admission_broker.mjs` is the Linux queue owner.
It considers requests from oldest to newest, reserving the oldest eligible memory
waiter's minimum supported floor before offering spare memory to later requests.
Eligibility requires that minimum to fit the current achievable memory; an
unachievable waiter retains its age and regains its reservation on recovery. New
arrivals cannot consume the capacity needed by that waiter as holders release;
once its floor is covered, younger requests can use the remainder even before
its payload starts. The broker's published `unreservedMemoryKiB` deducts that
head floor too, so AUTO ranks a fitting peer ahead of a head-reserved host using
the existing memory input. No aging deadline or cumulative backfill accounting is used. Workspace-busy
requests release their offered capacity and partial leases, then wait for their
own resource changes. A head blocked by an active publication also waits without
reserving its floor before its first offer. A physically fitting request can wait without an admission
deadline; `--no-wait` instead returns a typed busy result.

The broker excludes its queued control clients' proportional resident memory
from host memory pressure during its existing observations. It credits each
client process once, excluding descendants and pages already attributed to an
admitted tree. Missing proportional-memory observations receive no credit.
The jobs cgroup's headroom remains an independent ceiling after this credit;
waiting clients cannot increase that limit. Retained brokers adopt this change
only when they next start with current source.

The queued command's wait line reports its one-based position and the count ahead
among pending requests without an offered reservation, including workspace-blocked
requests. The broker publishes changes during its existing serialized passes;
unchanged positions stay quiet. Memory and workspace availability still decide
which request can proceed. An updated client connected to an older broker shows
only the total waiting count until that broker next starts with current source.

Executor signal diagnostics identify both the victim
execution and the initiating execution, with a distinct cleanup/cancellation
reason. Current callers distinguish `controller_orphan_cleanup`, `reaper_orphan`
and `custody_cancel`; `initiating_execution_id` names the initiator while
`execution_id` continues to name the victim. Standalone native execution without
an issued execution id says unknown. The shared signal emitter is sourced at
startup, so teardown can still run after source or fixture files disappear.

The broker's private pathname socket and client-owned slot witnesses carry
admission and payload lifetime. Broker restart reconnects surviving witnesses
and recovers their floors; queued clients carry their original arrival timestamp
in the existing request, preserving queue age and head-reservation ordering without
a persisted queue. Clients without a timestamp retain connection order. Reconnect
alone stays on the same host; terminal refusal can return control to placement.
The separate kernel startup mutex protects listener replacement and initial
recovery only. During the old-launcher transition, the broker also retains the
existing old scheduler flock for its entire runtime. The one-time cutover passes
already-held lock descriptions without an unlock gap, so late parsed old
launchers cannot admit alongside the broker. Already-admitted old work finishes;
its finite exit-event bridge wakes the broker without a periodic reaper.

Linux worker disk admission uses `worker_disk_budget.mjs` to observe free bytes on
the command's known write filesystems. It refuses an already exhausted filesystem.
Validation classes also require more than 1,931,718,656 free bytes: the largest
observed validation temporary root on mac2-linux occupied 1,886,444 KiB during the
2026-11-01 ENOSPC incident. Placement and host admission consume this same owner
decision; larger explicitly measured additional writes still govern. This is a
measured minimum for another validation run, not a peak guarantee or a reservation.
Resident dependencies, caches and retained outputs do not establish additional writes.
Insufficient measured headroom triggers
ordered custody reclamation of retired runtime-build staging and stale lane scratch.
Explicit maintenance can run that retention policy independently.
In current 0.3 development, a cold or incomplete command replica also requires room
for its measured missing source bytes before creating its root or starting synchronization.
Before remote dependency bootstrap, a cold Yarn checkout uses a matching admitted
installation, with equal checkout-owned dependency inputs and runtime identity, to
measure missing package copies, including workspace-local dependencies. Existing
single-link file allocation can offset replacement growth; shared links cannot.
When no matching admitted copy exists, admission keeps its existing disk checks and
emits `HSTACK_DEPENDENCY_FOOTPRINT_UNMEASURED`, naming the dependency identity and
the missing reference. Once a matching copy exists, measured demand governs admission.
These measurements are additional-write minima, not installation or staging peaks.
Warm admitted installations and pnpm retain their existing admission. Command
replicas are retained by worker maintenance: a marker and age do not prove that a
controller-owned synchronization session is inactive.
In current 0.3 development, scratch retention scans both the command's temporary
directory and the configured worker CLI home's `tmp` parent. Custody gives each
default command a private `hstack-*` child there; scanning only the child would
miss completed commands' historical siblings. Both parents use the same 24-hour
newest-descendant retention and complete live-process custody checks.
In 0.3 development, maintenance nominates the former worker `runtime-build/<stack>`
platform directories, private `store`, and `.incoming-happier-runtime-build-*` roots
through the historical reaper. Current runtime builds use temporary roots and normal
controller/worker teardown; abandoned final staging uses the same historical retention.
Unknown children, symlinks, recent descendant writes and live references are retained.
The SDK's private `happier-<uid>` directory is a shared namespace, never a job
root. Its canonical ownership reader lives in `packages/cli-common/tempDirOwnership.mjs`
and is also used by the typed temp-directory API. Historical cleanup preserves live
or unknown SDK creators, including publication callbacks holding only a JavaScript
reference. Maintenance nominates marked `runtime-build-*` children only after their
creator generation is gone, then applies the same age and process-reference checks;
the SDK removes unchanged sidecars only after their directory is absent.
A worker below its class's measured headroom is excluded before bootstrap/payload; pins report the disk
diagnostic. The execution-qualified disk marker never authorizes replay of a started
command. `dev-targets status` exposes free bytes. Admission does not guarantee capacity
for future writes or filesystem quotas; real write failures remain authoritative.

Linux `dev-targets status NAME` consumes the broker's cached available, reserved and queued memory with active/waiting counts. Queued commands block on sockets and can be observed through status. Status does not walk admission owner records or take a second process sample. Service-memory diagnostics remain separate and never decide capacity. Neither low CPU nor process age imposes an admission deadline or authorizes cancellation.

Admission records belong to the worker's host-local `/tmp/happier-heavyweight-admission-v3` root. PID observations on another host cannot retire them. At each decision, definite absence or a different kernel birth token stops counting the recorded process; unreadable birth or signal observations retain its reservation. These native records carry boot-relative birth ticks rather than a wall-clock start or boot witness, so a reboot alone does not prove retirement when the recorded PID and ticks still match. A terminal wrapper retains an envelope only while the current observer authenticates its surviving payload tree. No stale RSS snapshot can resurrect an absent or reused PID.

An explicit routed `hstack-exec --heavyweight-admission --class=... -- ...` carries its class into this same placement policy before committing to a worker. Payload flags after the delimiter do not change the envelope. Native memory observation uses the existing native process-identity owner without installed workspace dependencies, so fresh mirrors can enter admission before their first dependency bootstrap.

Default command scratch teardown runs on normal completion, failure and trappable
cancellation. After the command group is gone, it nominates only its own root to
the historical reaper without an age delay. The same tree identity and live
cwd/descriptor/mapping/binding checks apply, so a detached holder retains scratch
even after dropping `TMPDIR`; unavailable custody also retains it. Explicit
caller-provided `TMPDIR` remains caller-owned.

Stack unit roots, CLI default test homes/bins, external-hook configuration fixtures and docs-check fixtures use `scripts/testing/process/temporaryDirectories.mjs` for normal teardown. On Linux, custody's explicit `reap-test-temp-roots` mode can reclaim marked roots after their creator, process group and explicitly bound descendants are gone. Detached children inherit `HAPPIER_TEST_TEMP_ROOTS`; inaccessible ownership observations retain the root. Ordinary command dispatch does not sweep shared scratch. In current 0.3 development, explicit `reap-temp-roots` maintenance checks historical `happier-*`, `hstack-*`, `docs-check-*` and Yarn v1 `yarn--*` directories beneath the selected temporary parent. It reclaims only account-owned, non-symlink roots whose newest descendant mtime is older than 24 hours and which no live same-UID process uses as cwd, open descriptor, mapped file or inherited temp binding. For a known same-UID process denied by procfs dumpability, the historical reaper retries read-only observation through existing noninteractive `sudo` authorization. It never exempts a process by name, changes OS authorization, or elevates deletion. Unknown UID or still-unavailable same-UID visibility retains candidates; processes whose status identifies only foreign UIDs do not block this user's reclamation. Environment contents and privileged command output are never logged. The 24-hour margin does not limit admission waits. Reclamation logs paths and allocated bytes, counting hard-linked files once. Invoke historical maintenance through target-specific execution of `bash apps/stack/scripts/utils/dev_targets/remote_execution_custody.sh reap-temp-roots - historical-sweep`, with an explicit `TMPDIR` for a shared parent; it never signals processes.

Service placements do not exclude command hosts. OS available memory already accounts for current server/Expo/daemon/browser processes. Admission subtracts only unused admitted-work envelopes from that available memory; a service RSS estimate with shared-page overcount cannot block otherwise fitting work. Active builds retain their `runtime-build` class reservation. Diagnostics expose service memory and unused command reservations; no second placement list exists. A class larger than total physical RAM fails immediately with a remote-routing instruction. A fitting class waits for available capacity rather than treating a currently resident service as permanently reserved growth.

FIFO admission covers the oldest achievable memory waiter's minimum supported floor before offering spare memory to younger work. An active publication lease prevents that virtual reservation even before the waiter's first resource offer; the canonical publication observation wakes it when the lease changes. The broker owns ordering and capacity; clients own nonblocking workspace acquisition and payload witnesses. Resource changes and closure of the broker's connection to the client listener wake admission through existing events, with no waiter poll or decision mutex per request. Admission cannot make unavailable physical capacity appear.

Capacity exclusions are invocation-specific: healthy raw samples remain usable by focused work on smaller workers and retain the default 15-second positive probe TTL. Dependency-refresh waiting belongs to the bootstrap's workspace lock before payload admission, within the same cancellable target execution. A selected sync-flush failure tries another target before any command starts. Prerequisite and sync failures remain excluded for that invocation even after shared probe observations expire; an exhausted preparation pool settles with `HSTACK_EXEC_DISPATCH_REFUSED`. Configured `fallback=local` applies only when no remote target is reachable, with an explicit log. Explicit `includeLocal` participation, local placement and machine-local invocations remain distinct from fallback. Exit 137 remains authoritative and reports possible OOM with the last target memory sample; it is never automatically replayed. Outbound routing requires a cwd inside the synchronized repository; explicitly local publishers and already-placed children may use temporary repositories.

Development fleet workers hosted on Windows use the managed WSL2 backend: `dev-targets add NAME --managed-wsl --outer-ssh=ALIAS --outer-ssh-config-file=PATH --dedicated-cpus=N --dedicated-memory-gib=N` provisions a named Ubuntu 24.04 guest through an authenticated Windows SSH host. The guest remains a POSIX execution target under the existing synchronization, placement and admission owners. Configure automatic placement with the guest name only; the Windows host stays a manual boundary. Capacity is explicit and `.wslconfig` applies to all WSL2 guests for that Windows user. Provisioning requires other WSL workloads stopped; forced capacity changes refuse to stop other running distributions. Guest SSH keys are pinned through the authenticated host, and a Windows startup task keeps the guest running. This backend is development-only. Verify enrollment with `doctor`, `sync`, and a command through `dev-targets exec NAME` before selecting the guest for automatic placement.

Managed guest SSH publication uses the guest alias as its multiplex identity and proxies to the outer host's loopback address. This prevents guests on different hosts with the same SSH port from sharing a connection. Foreground Stack launchers forward interruption and wait for cleanup; explicit `dev-vm exec` and ordinary delegated commands use the same guest scope owner so cancellation cleans up the guest job before closing its host transport.

In 0.3 development, `apps/stack/bin/hstack-dev-target-control` owns the native per-session synchronization barrier for automatic and exact-target commands. Queued requests may share a successful Mutagen flush only when it started after each request captured demand. A request arriving during a flush requires a later cycle, so a just-written source file cannot be admitted against an earlier scan. Each caller checks fresh exact-session health before dispatch; failed or canceled flushes cannot satisfy demand. Platforms without `flock` retain a separate flush and health check for every request.

The 0.3 routing producer owns one Mutagen daemon/data directory for development
mirrors, separate from product workspace synchronization. Each source checkout
has its own project and one session per used target in that daemon; sibling
command configurations do not own daemons. Session identity includes the source
root, so two repositories routed to the same worker have independent causal
barriers. Stack and QA supervisors only borrow existing producer mirrors and
cannot replace their membership or retire them on shutdown. Provisioning and
retirement belong to the routing sync service. Source replicas retain authored
`.project/plans`, `.project/tasks` and `.project/scripts` inputs, including compiler
baselines and validation ledgers. Plan `refs` trees (`/.project/plans/**/refs`) are
controller-only reference checkouts and are ignored before scanning; absolute or
out-of-tree links there cannot prevent worker synchronization. Other source links
retain Mutagen's portable symbolic-link behavior. Apply source-policy changes with
`hstack dev-targets sync-service start --detached` through the routing producer.
Independent sync release, including
`dev-targets sync-service stop`, requires an explicit absolute
`HAPPIER_STACK_SYNC_SOURCE_DIR` for the checkout being retired, even for the primary
checkout. Missing or invalid scope fails before changing project ownership or
pausing sessions; it never defaults to the primary project. Native inspection of a
paused session reports `sync session paused (<project>)` with its Mutagen project
label (or session name if no label exists), without attempting a recovery flush.
A failed resume does not restart the shared daemon. Execution-host candidates are separate producers: each legacy
or named workspace uses its own project in that same repository scope, daemon,
OpenSSH configuration and lifecycle lock. Candidate refresh and activation pause
only that candidate project; ordinary routing mirrors keep running. Before project
retirement, a legacy candidate missing its state publication recovers source scopes
from its exact owned generated project files; malformed ownership or source evidence
blocks activation. The same pause and session readback then verify retirement.
Before project activation, the sync owner removes orphan writers from that project's existing
or desired session membership by exact session identifier, using Mutagen's project
label and current lock identity. A failed project termination preserves the project
file; replacement flushes current old membership before termination.
The same session inventory rejects activating a replica destination already owned
by another source with `DEV_TARGET_REPLICA_COLLISION`, before any project or writer
mutation. Existing sessions retain that ownership while paused.
Bundled plugins' entire `.happier-plugin` directories are replica-local build
outputs, including `plugin.json`. Workers materialize them from the controller's
synchronized `apps/cli/assets/bundled-plugin-manifests` declarations; a newly
created worker output directory therefore cannot conflict with its absence on
the controller.

Sibling command settings live only under the producer's `commands-<checkout>/dev-targets.json`;
target definitions derive from the producer, and service hosts derive from
the sibling's Stack config, with destinations scoped to the sibling checkout name.
Mac mirrors require a current Mac-only flow, not withdrawn
exact-target typechecks alone.

Sibling synchronization dispatch starts the existing detached
`command_replica_retirement.mjs` owner. It discovers absent sources from command
state and generated repository projects, including nested scratch sources. An
all-extant pass does not contact Mutagen or workers. Retirement records its exact
session and destination manifest before stopping writers, and each stop carries
that source's synchronization environment. A failed stop preserves that source's
worker replicas and recovery state. Worker removal requires its existing replica
owner marker; unmarked or unreachable directories remain pending. A one-off
session-only selection stops the named writers while preserving directories and
project state, including destinations shared with a primary checkout.

`mutagen_runtime.mjs` owns first-cycle readiness, including its generated `native_sync_readiness.sh` projection. A clean connected idle session with both endpoints in `no-watch` and no completed cycle is `needs-flush`: eligible for selection, with the mandatory dispatch barrier establishing a completed clean cycle before any payload. An active initial scan remains `synchronizing`. Status and doctor read the same classification; startup seeding also consumes it rather than deciding independently from watch/cycle fields.

Known scan races (`hashed size mismatch: <bytes> != <size>` from Mutagen 0.18.1)
and transition races (file modification during validation, a disappearing leaf,
or a missing staged file during permission application) request a fresh flush
through the same barrier, including before the first completed cycle. Candidate
probes admit this recoverable preparation without flushing any mirror; only the
selected worker crosses the mandatory clean barrier. Startup uses that barrier
too. The POSIX barrier continues Mutagen cycles while the canonical observation
reports this known transient churn and remains cancellable.
Native Windows consumers retain their existing flush retry and timeout with
the same readiness classification. Recovery never admits a payload until an
inspection is clean; unknown, excluded or permission-denied scan and transition
problems remain unhealthy.

Managed worker enrollment and automatic command placement attempt to disable sleep through `dev-targets power no-sleep NAME|auto`. Ordinary unmanaged SSH enrollment requires explicit `host prepare --no-sleep` or `power no-sleep`. Managed workers apply the same policy to their outer host and Linux guest. Windows disables AC/battery idle and unattended sleep, idle hibernation and lid-triggered sleep; macOS disables idle system sleep; Linux masks systemd sleep targets. Manual targets are excluded from automatic placement setup. An existing Windows machine policy enforcing zero satisfies that setting; conflicting policy remains an error. Administrator privileges are required, and denied settings are reported without blocking worker enrollment or changing placement. The explicit power command returns failure for incomplete configuration. These defaults belong to worker setup, not ordinary Happier installation on a personal computer.

In 0.3 development, Windows worker setup also installs the machine-wide `Happier-Worker-Power` task under SYSTEM, with boot and logon triggers and no execution deadline. Its administrator-protected script reapplies and verifies the same settings at boot and holds a named system power request. The existing per-user WSL task owns guest startup separately: running WSL alone does not prevent Modern Standby. The request keeps an AC-powered worker active while allowing its display to turn off. Windows limits power requests on battery and honors explicit user sleep; keep an unattended Modern Standby worker on AC. See Microsoft's [Modern Standby software preparation](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/prepare-software-for-modern-standby) and [power-request limits](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powersetrequest).

`dev-targets status NAME` reads power health for the host and guest alongside synchronization and runtime health, including effective Windows machine-policy overrides, the boot task and active power request. An unhealthy or unavailable power observation makes status fail without changing synchronization state. On macOS, incomplete idle-sleep policy reports the one-time host command `sudo pmset -a sleep 0`; Linux health requires all worker sleep targets to remain persistently masked. Power verification belongs to `worker_power.mjs`; status does not apply settings.



In 0.3 development, `apps/stack/scripts/utils/dev_targets/remote_commands.mjs` owns command classification; the native launcher consumes its generated `native_command_policy.sh` projection rather than maintaining another classifier. Native `node --test` commands receive installed-dependency readiness. Only source-proven test commands bypass workspace publication; unknown native commands retain component preparation. Stack dependency-closure publication is reserved for Stack validation, not every remote command. Default CLI/UI and cli-common Vitest configurations resolve workspace source; default UI tests use the typed empty bundled-app inventory fixture, while `vitest.artifact-cache.config.ts` retains generated inventory and artifact preparation. Workspace build currentness remains owned by the dependency-closure/fingerprint path; there is no separate `prepare:build-inputs` hook.

A native `*.test.mjs` suite whose dynamic tooling prevents automatic source-graph discovery can declare `// @happier-test-preparation source` on its first line after verifying that it consumes no workspace dist or publication outputs. The shared native input owner recognizes this declaration for any suite path; both AUTO and `--local` keep installed-dependency readiness and normal validation admission while skipping workspace publication. The declaration does not enumerate file inputs for source watchers. Undeclared suites and unknown loader overrides retain their existing preparation.

CLI Vitest classification reads the config's canonical workspace-source resolver and preserved config inheritance. Full integration setup retains compilation admission. For a source-only integration replay, `HAPPIER_CLI_TEST_SKIP_BUILD=1` skips both bundled-plugin publication and CLI dist compilation; admission consumes the same skip decision. Test bodies that invoke compilers retain compilation admission through the existing compiler-file inventory. Use the skip only when the selected tests do not require fresh packaged artifacts. Public native-custody preparation still runs before the source test payload. Unknown setup expressions and configs that replace the inherited resolver retain runtime preparation.

CLI tests that copy or natively import physical public SDK packages run in `vitest.integration.config.ts`, through the same canonical workspace preparation. This includes public-authoring activation, cross-copy `PluginError`, lone-file SDK resolution, scaffold compiler/UI journeys and prepublication author installs and packs. Current-source catalog and RPC compositions that activate workspace Agent modules use `apps/cli/vitest.source.integration.config.ts`. It reuses the integration lane's resolver, aliases, includes, pool and environment, with source-only setup: native process custody is prepared, while provider declarations come from the tracked manifest projection and activation loads the real development modules. CLI unit setup uses this same source role. Compiled CLI modules, including `dist` in a source checkout, still admit distribution publication failures; packaged and unknown roles retain fail-closed inventory checks. Source imports do not satisfy fixtures that consume copied package trees or prepared CLI subprocess outputs. Temporary filesystem/process fixtures that produce their own inputs remain source-owned.

Run a source integration slice through the canonical wrapper, for example:

```bash
./apps/stack/bin/hstack-exec -- pnpm --dir apps/cli run vitest:local run --config vitest.source.integration.config.ts src/api/apiMachine.preflightCatalogs.runtimeCatalog.integration.test.ts
```

The wrapper recognizes the preserved CLI workspace-source resolver and retains normal validation admission and installed-dependency readiness for this selection. Unproven custom configurations retain workspace preparation.

In current 0.3 development, routed test commands default their dependency preparation to the existing `qa-runtime` build mode. Source-only lanes still skip workspace publication; runtime consumers prepare their required outputs, with the workspace build owner reporting any last-green fallback. Explicit `HAPPIER_WORKSPACE_BUILD_MODE` preferences remain authoritative. Build, typecheck and unknown commands retain strict preparation, and publication lifecycle entry points always force strict compilation. Runtime preparation is not compiler proof; the owning typecheck/build lanes remain required.

Collect one complete reachable failure set, fix deterministic clusters locally, then rerun affected lanes. Use one final required hosted profile for the coherent source, not a full graph per test edit. Reuse successful evidence when source, dependencies, configuration, command, and environment remain applicable. New source or a previously unreachable candidate boundary can legitimately expose another failure.

Moving-source feature QA ends at source, integration, and the loaded development
runtime. A package tarball, candidate archive, or immutable release identity is
not an extra feature-completion gate. Exact-package consumer, integrity, and
publication checks run only inside an explicitly authorized release operation
against the bytes that operation may publish.

## Managed Lima networking (0.3 development)

`apps/stack/scripts/utils/managed_lima/profiles.mjs` owns network policy for
both controller and worker VZ guests. New instances include `vzNAT`; retained
instances change only through the explicit `network apply --force` command.
`lifecycle.mjs#applyManagedLimaNetworking` owns stop → network-only edit → start
and native configuration/power readback. The controller command wraps that
owner with its existing SSHFS and service-tunnel teardown/startup. Ordinary
start, recovery, doctor, and resource edits leave retained networks unchanged;
missing native NAT is not a new health failure that blocks existing commands.

The external basis is [Lima's VMNet contract](https://lima-vm.io/docs/config/network/vmnet/)
and the installed v2.0.3/v2.1.0/v2.2.0 source: added networks default to metric 100,
usernet uses 200, and VZ retains its usernet device beside native NAT. The
usernet subnet still carries host/DNS access. The forwarding configuration is
preserved, and Stack service/Mutagen SSH transport keeps its existing owners.
The installed versions pin gvisor-tap-vsock v0.8.7/v0.8.8/v0.8.9, whose TCP forwarder
admits 10 incomplete connection attempts; this is not an established-connection
limit. Incident counts alone do not prove its saturation.

CLI boundary fixtures cover network generation, explicit authorization,
idempotence, route-priority correction, retained configuration, and edit failure.
Live proof requires an owner-scheduled VM restart: record the Lima version and
instance/store, apply once, check the native default route plus usernet's
connected route, resolve DNS/`host.lima.internal`, probe SSH and actual Stack
tunnels, and confirm Mutagen reconnects. Do not restart a VM to satisfy a source
lane's tests. Operator steps and guest Tailscale identity are documented in the
[development VM guide](../apps/docs/content/docs/hstack/dev-vm.mdx) and
[worker guide](../apps/docs/content/docs/hstack/dev-targets.mdx).

`apps/stack/scripts/provision/linux-inotify.mjs` owns the owner-approved
inotify policy: `max_user_instances=1024`, `max_user_watches=2097152`, and
`max_queued_events=131072`, retaining any higher live limits. Managed guest provisioning invokes it outside
toolchain readiness; Linux/WSL `dev-targets host prepare --inotify` embeds it in
the existing one-sudo preparation session. The values provide headroom for the
measured 0.3 development fleet's 221,994 watches across 124 instances and a
16,803-watch CLI/server stack. OS-boundary fixtures execute the real shell policy against
isolated sysctl/file adapters and assert the persisted file, live value,
repeat behavior, and combined sudo scope. Live boot persistence still requires
the owner's post-restart readback; sysctl.d is a boot input on systemd guests,
not proof that every WSL init loads it. Removal is documented in both guides.

In 0.3 development, `devReloadCoordinator` owns one source observation service
per watch-mode stack. Native events invalidate `watchSignature` observations;
runtime source fingerprints consume those observations with their existing
encodings. A burst reaching half the actual Linux queue capacity recrawls once
after it settles. The default five-minute safety check stats known inputs
sequentially and only re-enumerates changed directories; generation activation
also checks known metadata. Successful server and daemon source snapshots close
their preparation watchers and retain no periodic source observation.

## Voice and audio validation

The current 0.3 development QA seam is [`createVoiceQaController`](../apps/ui/sources/voice/qa/voiceQaController.ts), with default dependencies in [`voiceQaRuntimeDeps.ts`](../apps/ui/sources/voice/qa/voiceQaRuntimeDeps.ts). Text and media start modes are distinct; media delegates to the normal Voice lifecycle owner and binds the exact Home-qualified Session target. [`voiceQaDebugRuntime.ts`](../apps/ui/sources/voice/qa/voiceQaDebugRuntime.ts) defines the development/debug-runtime check. This is a development validation aid, not a second Voice runtime or a release-availability claim.

Choose the evidence boundary before running a canary:

- Text injection tests turn/tool routing and textual results; it does not prove microphone capture, speech recognition, output audio or acoustic interruption.
- A media run must prove that input audio has energy and reaches the selected active transport. A live/enabled track or elapsed microphone time is insufficient. Measure the input and observe the expected transcript/result; capture output evidence separately when claiming audible behavior.
- Browser fixture capture can use Chromium's file-backed fake microphone when the browser supports it. Verify the loaded browser's actual track rather than assuming the launch flag worked. Simulator/emulator loopback tools are environment-specific aids, not substitutes for real device acoustics.
- Exercise permissions, cancellation, interruption, transport loss and terminal cleanup through the normal host owner. Record the actual runtime, platform, account and exact Session binding; a debug route or a text canary alone does not close the normal-UI journey.
- Physical microphone/speaker quality, AEC, Bluetooth routes, native audio focus and background/lock behavior need their named device/release checks. Missing hardware evidence is reported explicitly and does not manufacture another feature-completion gate.

In current 0.3 development, start a remote fake-audio QA browser with `hstack dev-targets browser start <lane-session> --stack=<qa> --fake-audio=packages/tests/fixtures/voice/phrases/short-command.24k.wav`; the checked-in speech says “Open the project settings,” is copied into the worker-owned profile, and still requires microphone permission (bare `--fake-audio` supplies Chromium's synthetic device instead). Browser start reads the current UI URL from Stack info, including the current Home port for borrowed Expo. Use `--url=<qa-ui-url>` only to select an explicit diagnostic URL; it is preserved as supplied.

An approved Voice program may require a larger composed journey; use its current execution recipe for that work. Standing evidence rules live here, while program status and past host measurements remain in the program's evidence.

## Test worker budgets

Ordinary Vitest configurations share `scripts/testing/vitestWorkers.ts`: the
default maximum is `max(1, min(4, floor(availableParallelism() / 2)))`, with a
minimum of one. Development and CI use the same default. Vitest otherwise sizes
an invocation from CPU count, not current machine load; several independent
invocations can still contend, so runner-level concurrency also matters.

In current 0.3 development, `hstack-exec` passes its governor budget separately
through `HAPPIER_VITEST_GOVERNOR_MAX_WORKERS`. The shared configuration uses the
smaller of that budget and the package default. The launcher does not turn a
derived budget into native Vitest pool variables or worker flags, which would
override package policy. Explicit shared, UI, native pool and CLI overrides
retain their existing precedence.

Linux derives the automatic allowance as `max(1, floor(cores / (admitted peers + 1)))`
from the executing host's broker-cached active count. Authenticated
descendants reuse their containing job's share; queued requests are not admitted
peers. Darwin retains the existing live dispatch-reservation count for the same
formula. Load still ranks placement, while PSI and run-queue telemetry remain
diagnostic. An explicit `GOMAXPROCS` value is preserved independently of Vitest's
allowance.

Linux development control and jobs scopes pass command operands literally to
the payload. Their systemd invocation disables environment expansion so shell
parameter expressions and worker environment overrides reach the owning shell.

Set `HAPPIER_VITEST_MAX_WORKERS` to a positive integer for an explicitly sized
local or CI job. CLI worker flags remain available for individual invocations.
The UI-only `VITEST_UI_MAX_FORKS` override remains supported with its existing
six-worker ceiling; the shared override takes precedence. Explicit single-fork,
single-thread and non-parallel lanes retain their stronger isolation contract.
No test selection, assertions or coverage settings change with this budget.

The current 0.3 public UI `test:unit` wrapper caps requested partition concurrency
at `max(1, floor(availableParallelism() / (maxWorkers + 1)))`, using the shared
worker policy above. Each partition owns a transform server and its fork pool;
keeping that pool together reuses its transform cache. With the default four-fork
budget, a 12-CPU worker admits two partitions and a 48-CPU worker can admit eight.
Native CLI worker overrides still retain Vitest's resolution and precedence.
Partition caches start cold; the wrapper does not persist a shared transform cache.

The pinned `vite-node+3.2.4` patch recognizes pending transitive import cycles
entered concurrently, complementing the Vitest patch that retains async-mock
import ancestry. `sources/dev/vitestAsyncMockContext.test.ts` in the UI owns the
real cycle and non-cycle controls; run them when upgrading either dependency
before removing a patch replaced upstream.

Automatic v0.3 Gate UI partitions run the UI `test:unit` wrapper with
`HAPPIER_UI_VITEST_PART`/`HAPPIER_UI_VITEST_PARTS` (eight parts). The wrapper lists the
suite once, splits it into batches of at most 128 files and gives each part a contiguous
range of batches. Each batch is one Vitest process whose transform cache serves all of its
files; the former 16-file batches repeated that cold transform for every batch. The non-UI
Gate partition runs CLI, Protocol, Server and plugin projects in one Vitest instance,
retaining package configs and running their non-Vitest checks after that instance closes.
The Gate supplies its worker budget through the shared worker override (two workers for
UI partitions, the observed core count for the non-UI partition);
without an override, partitions use the same canonical default described above.
Gate and UI unit entry points project that resolved budget into Vitest's native
pool environment, so inherited pool variables cannot select a competing budget.
Explicit UI CLI worker flags, including percentages, retain native Vitest precedence;
the Gate restores its previous environment before package adjunct checks.
CLI nightly partitions, integration runs and explicit diagnostic sharding retain
their existing invocation policies. Unit job deadlines are hang guards derived from
measured complete partitions (270 minutes for UI, 360 for the non-UI partition), not
performance targets; they include current-run artifact restoration but not shared
preparation. The UI wrapper does not impose a separate default watchdog;
an explicit `HAPPIER_UI_VITEST_SHARD_TIMEOUT_MS` remains available for diagnostic runs.
The existing Gate selector also owns one shared preparation
job: canonical frozen installation, native preparation and CLI/workspace closure
publication run there before compiler, unit and artifact jobs consume its exact-run
artifact. `prepare:typecheck:workspaces` combines the root package set and all
component prerequisites in one canonical workspace-build invocation, then generates
the UI artifact projection. Root typecheck and the Gate call this combined preparation
without a separate `build:packages` pass, so plugin publication happens once for that
combined scope. The Gate then uses `build:shared --source-dev` to finish CLI runtime
custody and verify readiness while reusing current plugin runtimes; the compiler
consumer still checks source semantics.

Only the compiler and artifact jobs consume built package outputs; unit jobs load
workspace packages from source. The Gate install therefore runs only the postinstalls
that do not compile workspace packages (`HAPPIER_INSTALL_SCOPE=cli,ui,docs`): Server
Prisma clients come from the dependency-admission step and Protocol's embedded
feature policies from their generator. `prepare:typecheck:workspaces` then runs as its
own step whose outcome is the job's `workspace_build` output. When a package fails to
build, the compiler and artifact jobs fail at their first step, the CLI closure and
the shared Iroh loader check are skipped, and the archive is still published without
the CLI readiness stamp, so every unit job still runs and reports. CLI unit tests
remain fail-closed on the Iroh loader check, which reads iroh-native's built output.
Dependency caching contains third-party dependencies only; a cache hit
still runs the canonical frozen installer and required postinstalls. Separately, v0.3
push runs save the built `packages/*/dist` and `packages/plugins/*/dist` trees when the
checked-out `packages` tree has no entry yet, and every Gate preparation restores the
newest entry of its build epoch (the lockfile, workspace file and build-owner sources
that every package fingerprint includes) before building. The workspace-build owner
reuses a restored package only when its recorded input fingerprint and output digests
still match, so the cache only skips rebuilding unchanged packages; a new epoch starts
from an empty tree. The installer
defaults `REDISMS_DISABLE_POSTINSTALL=1` to skip the optional Redis `stable` prefetch,
preserving explicit overrides; Redis adapter validation uses `REDIS_URL` or lazily
resolves its pinned runtime version instead. Successful installer output remains
in the job log. Cache-hit installation and prepared-artifact restore
are different measurements and must not be reported interchangeably.

The shared tar contains an explicit prepared-output inventory: dependency and
compiled/native directories, runtime tools, web assets, the existing ignored
generated compile inputs, and the CLI's exact public preparation-state files.
Dependencies nested under those prepared roots are included only through their
owning output directory, not archived again as separate dependency roots.
It does not classify Git changes or copy changed authored sources. Tracked
generated sources remain the responsibility of their generator and committed
checkout; they are not admitted through a workflow allowlist. Dependency cache
publication runs explicitly after a successful install, before later workspace
preparation can fail.
Cache keys retain dependency, toolchain and postinstall inputs, but exclude test
and spec files and `__tests__` directories; changing a keeper alone must not
invalidate installed dependencies.

Shared preparation currently has an interim 45-minute deadline. An observed cold
hosted preparation, including prerequisite builds and artifact transport, took
approximately 44 minutes 52 seconds and nearly exhausted that guard. Compiler
and artifact jobs retain interim 90/95-minute deadlines. These are bounded execution guards,
not a claim that the full Gate has met its 15-minute wall-clock target; reducing
preparation and the remaining bodies is still required.

## TypeScript toolchain

For ad hoc development dist refreshes, use `HAPPIER_WORKSPACE_BUILD_MODE=source-dev ./apps/stack/bin/hstack-exec -- node scripts/workspaces/ensureWorkspacePackagesBuiltCli.mjs <workspace-package>`; CI and publication retain strict checking.

The repository deliberately separates the compiler from the programmatic TypeScript API:

- In 0.3 development, pinned `tsrs` handles typechecks, including internal declaration partitions and routine CI, on Linux x64/arm64 and macOS arm64. `@typescript/native` provides Microsoft TypeScript 7.1.0-beta for builds/shipped declarations, release validation, editors, Windows and Intel Mac; Microsoft remains the final diagnostic authority. Set `HAPPIER_TYPESCRIPT_COMPILER=microsoft|tsrs` for typechecks (`auto` restores selection); builds and watch/tooling stay Microsoft. Missing binaries and compiler failures propagate without fallback. Tsrs incremental caches, internal declaration outputs and reference projections use `.tsrs`, preserving the Microsoft graph consumed by prepared CLI builds.
- `typescript` remains the TypeScript 5.9 API consumed by AST tooling and ecosystem integrations. Do not replace it with TypeScript 7 until the native release provides a stable compatible API and every consumer supports it.
- `scripts/workspaces/resolveTypeScriptCliInvocation.mjs` is the only compiler-selection owner. First-party scripts must use `runTypeScriptCli.mjs`, `buildTypeScriptPackageDist.mjs`, or that resolver directly; do not invoke a bare `tsc` shim or resolve `typescript/bin/tsc`.
- `pnpm run tsc ...` is defined at the repository root and in every TypeScript-owning workspace; it delegates to the same selector and runner.

### Agent rules (moved from root AGENTS.md "TypeScript compiler ownership")

- First-party compilation uses the shared selector: pinned `tsrs` owns typechecks, including internal declaration partitions and routine CI, on Linux x64/arm64 and macOS arm64. Microsoft TypeScript 7.1.0-beta from `@typescript/native` owns package builds/shipped declarations, release validation, editors, Windows and Intel Mac; Microsoft's verdict is final. `HAPPIER_TYPESCRIPT_COMPILER=microsoft|tsrs` overrides typechecks (`auto` restores platform/kind selection); builds stay Microsoft and compiler failures never fall back. Rust incremental caches and internal declaration projections use the `.tsrs` suffix. For an ad hoc development invocation, use `node scripts/workspaces/runTypeScriptCli.mjs ...` or `pnpm run tsc ...`: direct compilation routes through `hstack-exec` AUTO on POSIX, while executor/admitted descendants retain their selected machine. Standalone `--version`/`--help` queries and Windows stay local. The runner's leading `--local` delegates to executor policy; controller-local compilation also requires its explicit `--allow-local-compilation` override. Do not use that escape for whole-package checks on nl2.
- Never invoke bare `tsc`, `npx tsc`, `node_modules/.bin/tsc`, or `typescript/bin/tsc`; those can select the retained TypeScript 5 API package.
- `scripts/workspaces/resolveTypeScriptCliInvocation.mjs` is the only compiler-selection owner. Orchestrators import it or use `runTypeScriptCli.mjs`/`buildTypeScriptPackageDist.mjs`; never add compiler fallbacks.
- The `typescript` dependency remains on 5.9 for compiler-API consumers. Do not use it for compilation, remove it, or upgrade it independently without inventorying and validating those consumers.
- The direct-`node` prohibition applies to shipped product runtime paths, not documented repository development commands.

### Touched-path typecheck delta (0.3 development)

From the repository root, run `pnpm run typecheck:touched -- --baseline .project/tmp/systemic-orch/ui-1104b.locs apps/ui apps/ui/sources/path.ts`
(substitute `apps/cli` or `apps/server` and repository-relative files or directories).
This runs the package's complete public `typecheck` through `hstack-exec` AUTO,
using the canonical compiler, projects and existing incremental caches. It does
not create a scoped tsconfig or make compilation cheaper by omitting inputs.
The controller reads the explicit `--baseline <path>` inventory before dispatch
and compares it with location reports returned by the worker. `.project` is
controller-local and need not be synchronized. Choose the complete shared inventory
published by the integration owner; modification times never select a baseline. The baseline path, new and removed
`file:line:code` locations in the selected paths, and new locations elsewhere
(unattributed) are reported separately. Columns and diagnostic prose do not
change location identity. This command never advances the shared baseline.

Shared inventory paths are repository-relative, with separators and `..`
normalized by the compiler diagnostic parser. Existing package-relative
inventories remain readable when their source file exists; a repository-relative
source takes precedence. A path resolving to neither source is an invalid
shared baseline. There is no canonical `.locs` writer; the compiler location
collector already emits normalized repository-relative paths.

Exit 0 means no new diagnostics in the selected paths; exit 1 means new selected
diagnostics. The full package verdict is reported separately. Missing or invalid
baselines, global compiler diagnostics, and incomplete or failed launches return
exit 2, never a zero delta. Incomplete results include a bounded, redacted tail
of executor, package-manager and compiler-runner failure reasons from either
stream; compiler diagnostic prose stays private.
Review unattributed additions before claiming a lane
caused zero new diagnostics anywhere in its package. The ordinary runner's
automatic dirty-path snapshot remains advisory; it is not this shared baseline.

CLI typechecks run `tsconfig.foundation.json`, `tsconfig.services.json`,
`tsconfig.core.json`, `tsconfig.source.json`, `tsconfig.test.json` and
`tsconfig.test-ui.json` sequentially
through that runner, with declaration-producing project references between source
partitions. The derived input owner checks exactly-once editor-root coverage
before compilation. Every partition retains strict diagnostics.
UI checks its dependency-ordered `tsconfig.foundation.json`,
`tsconfig.core.json`, `tsconfig.source.json`, then `tsconfig.test-components.json`
and `tsconfig.test-other.json`, including the root source-workspace lane. The two
test projects inherit `tsconfig.test.json` and share its explicit fixture/config
and ambient roots; each test/spec root belongs to only one group. Source partitions own their complete imported
implementation graph; recursive components must not cross project boundaries.
All retain the original strictness, aliases and ambient declarations, with
separate incremental caches. The original
`tsconfig.json` remains the shared full-coverage base so existing configs that
extend it retain their coverage. Repeated
`--project` arguments check every project even after compiler diagnostics and
return a nonzero result if any project fails; cancellation or launch failure
stops the sequence. These large app programs explicitly use `--singleThreaded`
to avoid retaining duplicate native checker state. Use the public package
`typecheck` entry point to check every partition, not only the source config.

In 0.3 development, `scripts/workspaces/deriveTypecheckProjects.mjs` derives UI
and CLI file lists at the serial compiler choke point. The public UI entry checks
foundation, core, source, component tests and other tests; CLI checks foundation,
services, core, source, Node tests and UI-dependent tests. Their package entrypoints must pass those complete
ordered project sets so preparation refreshes membership before compilation on
both the local and AUTO-selected worker paths. The largest source dependency cycle
belongs to core, its prerequisites belong to foundation, and remaining editor roots
belong to source or tests. Shared ambient declarations contribute to every partition.
Imported authored TypeScript and JSON are included in their consuming closure.
The generator checks exactly-once editor-root coverage before writing finite
projects into each package's `node_modules/.cache/tsc/tsconfig.*.json`. These ignored
projects extend the authored configs, preserving option paths and redirecting
references to the other finite projects. Public checking leaves tracked configs
unchanged. `node apps/ui/scripts/deriveTypecheckProjects.mjs --check` detects stale
UI projections; the CLI script at `apps/cli/scripts/deriveTypecheckProjects.mjs`
provides the same check. Pass `--write-authored` to either generator for an explicit
refresh of its tracked membership lists. Adding, moving or deleting a source file
requires no manual partition registration.
Coverage validates the editor roots selected by that invocation's derivation,
including duplicate ownership. Files created while the graph is being derived
are selected on the next invocation, so concurrent additions cannot invalidate
an already selected program by changing the later coverage scan.

Bootstrap admits source tools and UI postinstall outputs without compiling Stack's
unrelated workspace closure. Ordinary source typechecks consume other workspace
packages through their declared type exports. The existing declaration-preparation
owner refreshes those outputs under publication custody without rebuilding dependency
JavaScript; consumers release that custody before checking. Producer self imports
still resolve to source. Finite checks retain their internal declaration partitions
and cross-app private-alias project references, which check producers under their own
options. Source discovery for those references still follows authored implementations.
Explicit declaration aliases retain their authored targets. Consumer strictness and
diagnostics remain intact; the compiler boundary removes foreign implementation
checks rather than filtering their output.

Before a source compiler batch starts, the runner records an in-memory filesystem
observation of its selected project roots and authored/generated configs. Its
terminal `[typecheck-inputs]` report gives `capturedAt` and the selected paths whose
metadata changed, while preserving the compiler verdict without discarding or
retrying the run. This is an observation of a moving checkout, not a frozen source
tree. Finite membership includes its imported source closure; ordinary single
projects report their selected roots rather than every transitive import.

In 0.3 development, captured compiler output is replayed and reported after each
compiler finishes. Capture uses private temporary files, so a descendant retaining
output descriptors cannot hold the compiler verdict behind a pipe's EOF. The
foreground process owner retains cancellation, numeric exit codes and signals;
uncaptured output continues to inherit the terminal.

Source reload workers explicitly preload Stack's authored-source bootstrap before
Node links their static imports; SSH does not inherit the controller preload.
Finite runtime, web and smoke preparation share `runSourceBuildCommand`'s Node
invocation policy, including the shared cold runtime producer. These tools resolve
workspace source rather than a shared `dist` that another builder can replace
during loading. Emitted CLI/server children retain their private built graphs.
Explicit source reload dispatch skips emitted workspace prerequisites; raw Node
workers retain their existing runtime preparation.

In development 0.3, replacement server/UI smoke is part of Stack service
lifecycle and runs directly through the existing process-custody owner, outside
the validation capacity queue. It retains the same authored-source Node
invocation policy and scratch-data isolation. The reload coordinator holds no
capacity reservation; finite builders and ordinary lane validation retain their
own admission. Existing service-memory observation accounts for the smoke tree.

The development 0.3 compiler-only Gate divides the root's existing compiler owners between
`--compiler-partition=ui` and `--compiler-partition=host` in its existing compiler
and artifact jobs. Both use `--prepared-workspaces` after the shared preparation;
neither repeats the complete compiler suite. The standalone root command still
checks every owner. Validate the partitions against the measured approximately
16 GB hosted memory boundary; parsed coverage alone is not memory-fit evidence.

After that same job's current-source compiler succeeds, the Gate passes
`--prepared-declarations` to `build:prepared`. The existing CLI build consumes
the source projects' declaration outputs instead of checking the whole source
graph again, and fails if a required emitted leaf is missing. Ordinary builds,
Stack callers and publication retain their independent strict source check;
the declaration-reuse flag cannot bypass publication lifecycle checks.

Ordinary CLI builds also use one native checker. Under the existing CLI
publication lock, `apps/cli/scripts/build.mjs` reuses the source-generation path
and its compiler metadata across dev-watch builds. Each generation replaces all
copied authored inputs and removes them after use; compiler paths keep internal
aliases on captured source and external aliases on their prepared dependency
declarations. The CLI uses its directly declared Zod declaration identity while
published workspace copies retain their own runtime dependencies. Only the
incremental cache survives. Unlocked builds keep private generations. Package
dist compilation uses one checker by default and the existing package-lock-owned compiler cache
in `scripts/workspaces/buildTypeScriptPackageDist.mjs`; an explicit
`--singleThreaded false` compiler argument opts out. Content currentness and
output promotion remain owned by the existing workspace build pipeline.

Before promotion, package dist builds prune retired compiler outputs using
the current compiler build-info input inventory and TypeScript's output-path
calculation. Deleted sources lose their JavaScript, declarations and maps in
both the persistent compiler tree and published `dist`; unchanged compiler
outputs and incremental state remain reusable. Corrupt or incomplete caches
still rebuild through the existing recovery path.

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

## UI native Sentry regression

The Android replay regression runs against the installed Sentry Gradle project and its production dependency graph. It wedges only the OS `MediaCodec` boundary, then verifies that the real replay cache can close without waiting for the encoder and cannot persist new segment metadata after closing.

From `apps/ui/android`, run through the checkout's `hstack-exec` with a configured Android SDK and JDK:

```sh
./gradlew -I ../tools/sentry/native-contract.init.gradle :sentry_react-native:testDebugUnitTest --tests io.sentry.android.replay.ReplayEncoderContractTest
```

Use `gradlew.bat` on Windows. This extends the vendor project's existing native unit-test task; it does not install an app or replace SDK dependencies for the test. The Sentry vendor patch includes the official profiler executor supplier adaptation needed by the updated Android SDK. Its replay close contract comes from [Sentry's encoder shutdown fix](https://github.com/getsentry/sentry-java/pull/5842).

## Native development-client load

Use the existing QA server and explicitly claim the simulator, emulator and a free
Metro port. Keep other stacks and Metros with their lifecycle owners. Run these
commands from the controller checkout; the app and APK paths refer to matching
native development builds on the Mac. Rebuild native dependencies through
`hstack mobile` when they change; a JavaScript reload cannot update a native build.

Start the canonical source UI preparation and Metro in one retained terminal:

```sh
./apps/stack/bin/hstack-exec --target=mac-host --cwd=apps/ui -- \
  env APP_ENV=development EXPO_PUBLIC_HAPPY_SERVER_URL="$QA_SERVER_URL" \
  node scripts/ensureWorkspacePackagesBuilt.mjs --expo start --dev-client \
  --host lan --port "$METRO_PORT" --scheme happier-dev
```

Development web and native requests include dynamic imports in one Metro graph
and evaluate them on demand. Lazy development chunks create separate overlapping
transitive graphs per entry; the live web trial stalled root and child requests
for several minutes. The canonical request rewrite keeps bundle, map and HMR
policy aligned. Production retains Expo's bundling mode.
Expo resolves the canonical web app entry for every development bundle, map and
HMR request, including chunk URLs retained by older tabs. Chunk responses keep
their module-only, non-executing options, so they reuse that graph without
reinstalling the runtime or running the app entry again.
Web translation payloads and Shiki grammars use registered Expo assets so their
unselected bodies stay outside the initial development response. English fallback
remains synchronous; the existing locale owner awaits the selected compiled
locale, including formatter functions, and retains its cache and explicit retry
behavior. Native translation loading keeps its synchronous adapter.
The source UI preparation child builds both asset inventories for the live or
captured UI project. Its existing Metro watcher refreshes changed inputs through
one queue, reuses unchanged producer inputs, and publishes source references only
after Metro indexes their asset files. Startup admission requires the inventories
and consumed files; finite exports prepare them in the captured project before
Expo collects assets. Executable translation assets use the app's ordinary script
evaluation policy; a custom deployment CSP that prohibits evaluation requires
separate deployment validation.
For stable native profiling, disable Fast Refresh in the React Native Dev Menu.
That pauses update application; explicit reloads remain separate.

Install the matching builds without removing device data, then open the explicit
development-client URL. `IOS_APP`, `IOS_BUNDLE_ID`, `ANDROID_APK` and
`ANDROID_PACKAGE` identify those builds; `IOS_UDID` and `ANDROID_SERIAL` identify
the claimed devices. Terminate an already running iOS app by its bundle ID before
each cold-load observation.

```sh
./apps/stack/bin/hstack-exec --target=mac-host -- \
  xcrun simctl install "$IOS_UDID" "$IOS_APP"
./apps/stack/bin/hstack-exec --target=mac-host -- \
  adb -s "$ANDROID_SERIAL" install -r "$ANDROID_APK"
./apps/stack/bin/hstack-exec --target=mac-host -- \
  adb -s "$ANDROID_SERIAL" reverse "tcp:$METRO_PORT" "tcp:$METRO_PORT"
DEV_CLIENT_URL="happier-dev://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A${METRO_PORT}"
./apps/stack/bin/hstack-exec --target=mac-host -- \
  xcrun simctl openurl "$IOS_UDID" "$DEV_CLIENT_URL"
./apps/stack/bin/hstack-exec --target=mac-host -- \
  adb -s "$ANDROID_SERIAL" shell am force-stop "$ANDROID_PACKAGE"
./apps/stack/bin/hstack-exec --target=mac-host -- \
  adb -s "$ANDROID_SERIAL" shell am start -W -a android.intent.action.VIEW \
  -d "$DEV_CLIENT_URL" -p "$ANDROID_PACKAGE"
```

The native intent owner sends Expo's launcher URL to the app root. `/status`
confirms the listener only: observe native bundling progress and the resulting
screen. Record launch-to-Home time twice per platform, the selected QA Home and
its connection state. An onboarding screen requires the existing approved QA
account/Home restore flow before it proves an authenticated Home load. Keep
credentials and recovery material out of tool output. If a missing-file error
survives completed source synchronization while the file exists, retain that
evidence and have the owner restart only that Metro; do not clear app data or
introduce another artifact generator. Restore borrowed device Home selections,
remove only the reverse mapping added above, and stop the owned Metro afterward.

## UI native Markdown regression

The Android Markdown contract runs against the installed enriched-markdown Gradle project with Robolectric native graphics. It checks paragraph span ordering, selection and buffer ownership, nested checkbox drawing and reflow, and table measurement. Its dense-text probe reports render, view adoption, layout construction, width scanning, and measurement-store timings; timing values have no uncalibrated pass/fail threshold.

From `apps/ui/android`, run through the checkout's `hstack-exec` with a configured Android SDK and JDK:

```sh
./gradlew -I ../tools/markdown/native-contract.init.gradle :react-native-enriched-markdown:testDebugUnitTest --tests com.swmansion.enriched.markdown.MarkdownLayoutContractTest
```

Use `gradlew.bat` on Windows. The vendor patch preserves the renderer's span index through measurement and view adoption, adapting [upstream's ordered no-copy buffer change](https://github.com/software-mansion/enriched-markdown/commit/7bcab4e4ac63bac876802b1603b058e0d625d765) to the 0.5.0 measurement and table consumers. This unit lane compiles the native module without installing an app; device validation still requires a client attributed to the current source.

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
- CLI runtime import cycles are fail-closed: update the baseline only for known debt, and keep `pnpm run test:import-cycles` wired through the root script and `@happier-dev/cli` unit lane so CI exercises it with CLI tests.
