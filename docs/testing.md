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

In 0.3 development, `pnpm --filter @happier-dev/cli run test:unit src/api/artifacts/accountArtifactStore.test.ts` forwards the file selection through the routed script chain and runs it once. Explicit runner arguments, including file and test-name filters, bypass automatic sharding and the unit lane's unrelated native checks. An unfiltered unit run retains its shard/CI-part selection, native script tests and import-cycle guard. CLI unit aliases use source-test preparation. Explicit test-file requests retain the existing validation envelope; the complete lane uses the existing compilation envelope because it executes real compiler owners. Focused compiler-consuming requests use the explicit compilation-class wrapper inside a routed outer `hstack-exec` command, never a controller-local admission implementation.

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
absolute. When selecting command execution policy, POSIX native and JavaScript
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
An authenticated inherited dependency reader, like an inherited workspace
publication lease, cannot wait for capacity or a foreign producer while holding
that resource. The declaration phase of an already-admitted typecheck is the
narrow exception: it reuses compilation capacity and may wait for package
publication while holding only its dependency reader, with no inherited package
writer. Native and in-process preparation use the existing custody owner to
enforce this ordering. Simulated independent workers in tests use
`buildNativeAdmissionFixtureEnv` so the containing suite's real custody does not
cross their physical-worker boundary.

## Choose checks by the changed contract

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

In 0.3 development, public package typechecks prepare their workspace-package
prerequisites on the selected worker before compiling. The canonical workspace
build owner verifies its content records, reuses fresh outputs without starting
builds, and publishes stale prerequisites in `source-dev` mode. Prerequisite
publication releases its leases and capacity before consumer compilation; it
does not change the selected typecheck compiler or certify producer semantics.
The parked declaration-only emitter remains unused. Authored CLI-to-UI source
references retain their separate strict declaration preparation and the
emitted-this-invocation guard for continuing after producer diagnostics.

The development-only `remote_validation_preparation.mjs --typecheck-batch`
command explicitly prepares and reads on one selected worker. Repeat
`--component-relative-dir=PATH` for consuming components, then supply `--` and
the finite reader command. It collects the union of canonical producer resources
before native admission, publishes strict prerequisites sequentially using
authenticated inherited custody, completes each consuming component's bundled
sync, then runs the reader. Graph changes unwind admission before the existing
single trailing pass recollects resources. This explicit validation command is
not enabled in automatic public dispatch.

In 0.3 development, `runTypeScriptCli.mjs` records each completed finite
`noEmit` package invocation in the ignored package-local
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

After a failed compilation, the reader checks producer records in dependency
order and appends one hint line after the compiler diagnostics for the first
noncurrent producer, with one explicit rebuild command to run from the repository
root. This runs on the worker and reaches the caller through `hstack-exec`, and
preserves the compiler's diagnostics and exit status. It checks the preparation's
build mode, so fresh unchecked development output is not mistaken for stale
content. The hint does not establish
that stale declarations caused the failure; passing checks do not run this
diagnostic or certify producer freshness. The hint itself never rebuilds or
retries; public typechecks already prepare prerequisites before compiling.
If declaration-shaped diagnostics remain, the explicit preparation command can
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

Remote dependency bootstrap reuses the existing per-install dependency refresh lock and checks freshness again after waiting, so same-input callers share the completed installation. In 0.3 development, both remote command entry points finish dependency and workspace preparation before reserving the payload's heavyweight admission envelope. Preparation's compiler leaves retain their own admission. This order lets a dependency/build lock holder obtain admission while another command waits for that lock. Dependency waiters remain behind a live installer without an acquisition deadline; a delayed JavaScript heartbeat during synchronous package-manager work does not permit replacing that owner. The existing lock owner still reclaims exited installers and stale malformed lock records. A package-manager install running under that writer lock receives its environment from the lock owner: the writer's custody, so first-party workspace postinstall builds that take read custody of the same lock inherit it instead of waiting on the install that runs them, and `HAPPIER_INSTALL_SCOPE=cli` unless the caller set a scope. Native admission decisions reclaim dead owners and owner directories with an unreadable or incomplete process identity under the existing capacity lock; read-only memory samples do not mutate those records.

Shared dependency-reader timestamps advance on join/release, not periodically;
heartbeat age alone is not proof of departure. On Linux, the canonical PID observer
also recognizes a positively observed zombie as departed even while signal0 succeeds.
Stopped or blocked live processes and unavailable procfs evidence retain conservative
liveness; this adds no heartbeat-expiry eviction policy.

In 0.3 development, local validation preparation reads dependency readiness through `dependency_refresh.mjs#assertDependenciesReady`. Stale, missing or damaged dependencies, incomplete UI postinstall outputs, and an active installer return `HAPPIER_DEPENDENCIES_NEED_REFRESH` before installation, repair or lock-queue registration. An active installer diagnostic includes its PID and held/heartbeat ages. Refresh/skip/service settings do not grant validation mutation authority; an explicit refresh remains with the canonical dependency owner and its [Stack and Expo dependency barrier](binary-runtime.md). Bootstrap defaults to local admission, and both remote command transports explicitly select worker preparation. A worker refresh returns `HAPPIER_DEPENDENCY_STACK_START_IN_PROGRESS` while a live source-start marker covers preparation, spawn and readiness; retry after the start completes. Worker source-test/typecheck preparation instead waits for a foreign marker's readiness or failure cleanup, outside dependency custody and writer priority, then rechecks under the same lock. A caller's own Stack marker retains refusal, and cancellation closes the wait. Running Stack runners and retained server/daemon processes do not block refresh. Successful refresh prints their Stack names and records `stacksNeedingRestart` in dependency readiness for restart at the owner's next boundary; warm validation remains a reader.

Declared installation-input directories track executable lifecycle scripts and assets, excluding conventional `.test`/`.spec` JavaScript and TypeScript files. The dependency owner ignores those test entries in existing v6 readiness snapshots too, without rewriting admission or installing. Editing, adding or deleting a lifecycle test therefore leaves unchanged installed bytes admitted, including during another Stack's pending start. Executable script, asset, manifest, lockfile and toolchain changes still require their existing freshness checks.

Scriptless bootstrap remains for synchronized replicas. Every worker role completes UI's canonical `postinstall:real` under dependency admission after an install, including forced package repairs. Readiness verifies every applicable UI patch in both hoisted and app-local copies, enriched-markdown's generated JavaScript/WASM outputs, and mandatory postinstall assets before publishing the installed tree. Healthy warm preparation only reads dependency bytes. Warm output repair preserves the installed tree's existing full admission when no extraction occurred. Missing markdown artifacts are repaired through the existing postinstall patch owner before its strict all-package patch pass; they do not require re-extracting healthy dependencies. Dependency-lock consumers, including Expo startup, use the existing workspace wait notifier to report the holder while waiting.

Finite runtime, source-web and workspace-package producers include dependency custody in the existing joint native admission transaction. A busy capacity decision releases dependency and publication scopes before waiting, then retries through that same owner. Stack run/start, remote validation and named workspace preparation must not hold the dependency scope around children queued for native admission. Admitted children inherit dependency custody through their final captured-input read and cleanup; parallel descendants reuse that custody rather than waiting on their parent. Dependency refresh therefore cannot replace the installed bytes consumed by a running finite build.

A dependency scope shares finite exports and read-only verification concurrently.
Its existing JSON owner records each active reader; the existing short ticket
registration lock serializes joins, releases and writer admission. A queued
dependency refresh blocks new independent readers, then runs exclusively after
all current readers finish; writers retain FIFO order. Healthy Stack startup
verifies installed admission under shared read custody without joining the mutation
queue. Warm worker source tests and typechecks use the same read custody and retain
the installed admission marker; they request a writer only when installed inputs
or mandatory UI outputs need refresh. Component-owned output preparation remains
separate from dependency freshness, while missing patches/assets and stale installed inputs still use the
canonical writer. Already-loaded untyped lock owners remain conservatively
treated as possible writers by read-only verification.

JSON lock holders and waiters publish complete owner records atomically.
Wait observation ignores unrelated directory writes and existing-ticket
heartbeats; ticket joins/removals, holder changes and the existing catch-up
still drive admission and departed-owner recovery. When a queued writer blocks
a free lock, the wait diagnostic identifies that queued owner explicitly.

Native Linux liveness rejects unreaped zombie and dead process states even when
the PID and start token still match. The existing admitted-tree observer keeps
a terminal wrapper's reservation while an authenticated live payload survives;
no remaining live workload permits reclamation. Admission logs successful owner
reclamation and removes terminal waiters from queue ordering. Sleeping, blocked, stopped and
orphaned live work retains its reservation: age, low CPU and a missing launching
shell do not prove that its protected workload has ended. Validation concurrency
is constrained by the existing memory envelopes and FIFO/backfill policy rather
than a fixed one-job slot.

In current 0.3 development, finite workspace publishers declare their existing
package/publication leases to `workspace_build_admission.mjs`; native
`hstack-exec` is the single joint lease/capacity owner. Plain and workspace
waiters join the same blocking kernel decision-mutex queue before acquiring
new leases. AUTO reroutes pre-dispatch capacity refusals through the eligible
pool once, then uses the existing candidate ranking to join one healthy worker's
native queue. Queue waiting retains its custody, resource-aware backfill and
cancellation without repeating selection, synchronization or bootstrap. Busy
workers receive no failure TTL and do not justify local fallback. Runtime-control
alternative probes remain nonblocking while their original waiter retains custody.
Under that mutex, a publisher tries its leases without waiting;
a busy attempt releases every new lease and yields head priority while keeping
its waiter and original queue age. Capacity-denied attempts likewise release
new leases before retrying. Only a ready lease transaction is admitted. The
generic compiler, CLI-common, SDK prepared-script, CLI readiness
and source-bundle publishers use this path; prerequisites finish outside their
publication transaction. Completed source-bundle lookup, recovery and selection
use short publication custody directly. Standalone and in-process publishers
try all declared resources without waiting, release partial acquisitions before
an event wait, and never retry an error from an entered publisher.
Package-manifest and exact-entry facts preserve placement and effective compiler
class while letting finite publishers reserve their own envelope. A lifecycle
containing a finite publisher can also defer to its canonical TypeScript leaf
after prerequisite publication. Bare compilers and pure compiler scripts retain
outer admission with reentrant leaf validation. Explicit command environment/cwd overrides participate
in that same policy. No second class table, admission budget or deadline is added.

Containing typechecks reserve the envelope of their declared producer graph before
starting. A CLI test project that references UI source therefore includes the UI
declaration producer's envelope; narrower CLI projects retain their own class.
Nested native commands reuse their authenticated ancestor's reservation, including
when lifecycle adapters lose admission environment context: the existing live
owner record and kernel ancestry must still agree. An enlargement gets one
nonblocking decision. If capacity or the decision mutex is unavailable, it returns
`HSTACK_NESTED_ADMISSION_CAPACITY` so the caller can reserve the composed workload
before starting its parent. It never waits for more capacity while retaining the
parent's reservation. Joint publication workers require their containing admission
instead of creating a second holder if the communicated identity is invalid.

Package input fingerprints use the actual package workspace's compiler-owner
scripts, not a different checkout selected by the running Stack's environment.
Explicit captured-origin remapping remains supported. A compiler-owner change
invalidates that workspace's cached output through the existing build owner;
an unrelated runtime checkout's script change does not.

The same publisher's `.happier-build-inputs.json` record can retain worker-local
output verification alongside its content digests: size, device, inode, and
nanosecond modification/change times. Matching file identity reuses the recorded
digest; changed identity verifies content again. Membership checks remain active,
including retained live outputs. Old or copied records verify once before the
publisher persists proof under its publication lease. Proof is captured from final
published paths and written atomically last; it does not change semantic output
identity or establish artifact authenticity.

In 0.3 development, denied admission attempts keep one custody worker and its
directory watches across retries. Lease release, queue changes and reservation
retirement wake that worker; its snapshot precedes the decision and is rechecked
after arming the wait. The native owner's existing catch-up cadence still
samples external memory changes, missed notifications and exited owners. A
plain no-wait probe starts no custody worker. JSON dependency/publication locks
reuse the workspace lock's notification mechanics while retaining their own
owner recovery and FIFO rules; heartbeat-only writes do not rescan healthy
contention. They share the workspace watcher's one-second catch-up default,
bounded by their existing acquisition and stale-owner budgets; legacy 125/250 ms
poll settings do not keep healthy owners on periodic scans.

Admission watches filter shared lock directories to the relevant lease and
queue filenames. After acquiring and releasing all workspace resources because
capacity or queue priority declined admission, the worker observes admission
owners and queue changes only; independent publisher lease churn cannot free
capacity. A resource-busy attempt still observes its leases and dependency writer
queue. Both paths retain the existing catch-up and dead-owner recovery rules.

`hstack-exec --cwd=REPO_RELATIVE_PATH -- COMMAND ...` also works with AUTO
placement. The selected target resolves the path against its repository; AUTO
retries retain it, and configured local fallback resolves it against the local
repository. Absolute paths and parent traversal are rejected. `--env` and `--tty`
still require an explicit target.

Admission refusals and waits use the same reason formatter. Memory decisions
report available, required and reserved memory; queue decisions name the deciding
head PID, class and envelope. A contended decision lock is reported explicitly.

Authenticated descendants may reenter their own leases and envelope. A charged
payload cannot wait for a foreign publication lease, including a lock-only
consumer: native admission marks this restriction, and the canonical workspace
lock refuses contention with `HSTACK_WORKSPACE_ADMISSION_ORDER`. An inherited
dependency read cannot upgrade to mutation custody for the same installation:
the dependency owner refuses that cycle with the same admission-order code.
Prepare the refresh before finite consumption. Independent writers still acquire
the existing mutation lock. An inherited
lease cannot queue a compiler or capacity escalation either. Move that producer
before payload admission rather than retrying beneath the same charged ancestor.
Local prerequisite preparation likewise precedes admission. Ordinary Linux CI
keeps its compiler-admission exemption; non-Linux retains its existing execution
policy and canonical workspace leases. These changes do not replace already
loaded launchers; a stranded old invocation requires owner-controlled retirement
and reinvocation, never an unrelated Stack restart.

Routed POSIX commands default scratch beneath `tmp` in the configured worker CLI home, on the worker's disk-backed filesystem. On Linux, custody allocates a unique `hstack-*` directory there and exports it as `TMPDIR` before admission, preparation and payload execution. After the payload group stops, custody reuses its process-binding inventory to remove that command's scratch, including package-manager scratch and killed test fixtures. A surviving group, inherited `TMPDIR`/test-root binding or unavailable newer-process observation retains it. Explicit `TMPDIR` remains caller-owned and unchanged; non-Linux commands retain the shared disk-backed default. This prevents default test/build scratch from consuming RAM-backed `/tmp` quotas.

For broad local collection, inspect `node scripts/pipeline/run.mjs checks --profile fast --dry-run` first. For a focused rerun, use a workspace command or `checks --profile custom --custom-checks integration,typecheck --install-deps false`. Custom selection is exact, not an implicit full baseline. The checks owner collects independent failures and returns nonzero; install failure still stops dependent checks.

Local and hosted profiles share selection policy ownership in `scripts/pipeline/checks/lib/checks-profile.mjs`, but are not interchangeable matrices: local profiles preserve local toolchain coverage; hosted profiles include platform/runner jobs. Read the current command help or workflow inputs instead of assuming a local `fast` result certifies hosted `release` coverage. In 0.3, route these commands through `hstack-exec`; its public test scripts already do so.

In 0.3 development, a direct `hstack-exec` invocation from a configured Mac workspace delegates to its active primary execution host through the existing execution-host bridge. The authoritative host's native dispatcher then selects a worker using its own current configuration. Package working directories, launcher flags, explicit environment arguments and exit results survive that handoff. Explicit `--local`, already-placed children, CI and sandbox invocations retain their local paths; candidate profiles do not activate delegation.

In current 0.3 development, active execution-host delegation retains a running guest when only capacity or toolchain updates are pending. It warns with the pending update instead of requiring provisioning or a VM restart before Stack control and command execution, including 0.2 commands using the 0.3 controller. Each guest command still enforces its own tool requirements. Doctor continues to report full provisioning compliance; candidate execution, unavailable guest session management, creation identity drift and security configuration drift remain blocking. The existing known legacy Lima service-forward cutover exception remains transport-specific. Delegation does not apply updates or restart the guest.

The development launcher also accepts `--repo=/absolute/sibling/checkout` before its other options. That checkout has a separate command placement policy and mirror on the configured `mac2-linux`/`windows2-linux` subset by default; change the subset through `dev-targets placement set commands ... --repo=...`. Its Mutagen project uses the same ignore policy and `no-watch` at both ends for command-only targets. Explicit service placements from the sibling's own Stack configuration retain their exact endpoints in that same producer-owned project, with source watching for service targets; `mac-host` remains excluded from automatic command placement. The project seeds each new session once, then crosses the existing selected-target synchronization barrier on dispatch. Admission, AUTO retries, custody and dependency freshness remain 0.3-owned; installation and UI postinstall consume the sibling's own lockfile and source, and dependency builds use its existing workspace owner. From 0.2, the optional thin `apps/stack/bin/hstack-exec` delegates when its executable 0.3 sibling exists. Without that sibling, or with `HAPPIER_ROUTED_EXECUTOR=0`, it executes locally with native stdio, exit and signal behavior. Ordinary 0.2 package scripts are not automatically rewritten; invoke them through the wrapper.

Development command placement uses the native `apps/stack/bin/hstack-exec` owner, including POSIX commands launched through `dev-targets exec auto`. CPU load and used/available memory rank reachable targets. `remote_commands.mjs` owns both workload classification and memory envelopes; its generated `native_command_policy.sh` is consumed by selection, Linux/WSL admission, and explicit local execution. Measured package dist peaks fit the existing 6 GiB `package-dist` envelope: cli-common and Protocol's earlier Linux dist peaks were 1,853,332 and 4,682,608 KiB respectively. Canonical runtime worker requests use `runtime-build` with an 18 GiB envelope: a successful full daemon build on Linux x64 peaked at 16,442,992 KiB of aggregate process-tree RSS. Adding the measured package envelope's 1,608,848 KiB of spare headroom and rounding up to whole GiB gives 18 GiB. Two sequential public TS7 app checks on Linux ARM64 on 2026-10-09 observed largest process-tree metrics of 18,909,772 KiB for UI, 13,688,852 KiB for CLI and 14,179,616 KiB for server. Adding that same headroom and rounding up gives `compilation-ui` 20 GiB, `compilation-cli` 15 GiB and `compilation-server` 16 GiB. The owner decision applies those observations despite incomplete import graphs; they are not certified maxima and must be re-derived if a clean graph measures higher. Unscoped/mixed-package checks and unmeasured builds use the UI-sized 20 GiB `compilation` envelope; serial projects within one package retain its package class. Admission diagnostics and compiler OOMs expose insufficient headroom. Focused validation and dependency installation retain their existing 6 GiB envelope, derived from the earlier approximately 5.3 GB compiler and 1.1 GB suite footprints.

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
builds reuse `package-dist`; Protocol and SDK use `runtime-build` because their
public-check observations plus headroom exceed 6 GiB. Emit-only builds retain
`package-dist`. Root and cross-package project builds retain `compilation`.

Development SSH commands, probes and native execution share the OpenSSH control socket selected by the synchronization owner's generated configuration (`sync_project.mjs#prepareDevTargetOpenSsh`). Generated defaults use `ControlMaster auto` and ten idle minutes of persistence; explicit guest socket paths remain in place. The native launcher's existing master-creation lock waits for its live creator instead of opening a new connection on contention. Stack and browser forwards remain dedicated because their owner must remove its listeners on stop without killing another session's master. Enrollment and controller-key verification use independent handshakes rather than treating an already-authenticated master as proof of the configured key. The opt-in Linux host policies and their removal are documented in `apps/docs/content/docs/hstack/dev-targets.mdx`; neither enrollment nor ordinary dispatch applies them.

In 0.3 development, supervisor bootstrap, readiness and worker channels reuse that configured master. Stack service retirement keeps independent control transport so saturated session channels cannot block cleanup. The browser owner restores a disconnected SSH forward while its worker is alive, preserving its CDP port and reverse SOCKS binding; a failed replacement or owner cancellation closes the owned worker and listeners. It does not restart a Stack. `dev-targets host prepare NAME --inspect-ssh [--ssh-log-since=TIME]` is a read-only inspection mode at the same privileged host-preparation owner: it prints effective sshd limits and aggregate journal counts, without printing authentication identities or keys. Run it separately from host-setting changes; it requires existing noninteractive root/sudo access.

Source-replica readiness shares one known-transition-race policy between JSON consumers and native placement. A staged-file relocation collision requests the existing causal flush and requires fresh clean evidence before selection; permission failures, unknown errors and excluded transition evidence remain fail closed. Placement surfaces the recovery diagnostics, while flush progress stays on stderr rather than contaminating its health record. Translation declaration tests keep their fixture and declaration output in private OS temporary storage, outside the synchronized source tree.

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
`service_placement.mjs#DEFAULT_QA_TARGET_NAMES` orders the default browser pool and new QA creation
projection consumed by `stack_commands.mjs` as `nl1`, `nl2`, `linux3`, `linux2`, `linux1`.
Explicit candidate pools stay exact;
creation defaults never retrofit existing Machine pins. Browser placement ranks the pool for its
own lifetime and does not move the daemon. The implicit browser pool includes only candidates
registered in that consumer's existing target registry, so registries predating either worker still work.
An empty implicit pool and an unknown explicitly named target fail without local browser fallback.

In current 0.3 development, an unplaced package-script command whose entire payload directly invokes `hstack-exec --script=...`, without local pre/post hooks, reaches that script before the outer launcher selects a host or reserves memory. The package manifest owns this delegation, including `--dir` and pnpm workspace filters; there is no separate list of routed script names. The script's dispatcher owns placement and admission on the executing host. Binary runners, implementation scripts, already-placed commands and genuine local payloads keep their existing admission envelopes.

On the Linux controller, explicit `--local` heavyweight compilation (including package-dist and runtime-build) refuses by default and points to AUTO. A caller can explicitly authorize `--local --allow-local-compilation`; this changes placement only and retains class admission plus the existing 8 GiB local floor, even under CI. Deferred finite producers and compiler leaves inherit that admission requirement rather than reserving their package-manager parent. Already-placed workers do not require the controller override. Light local commands remain immediate. Ordinary automatic CI execution retains its existing exemption.

Linux AUTO keeps heavyweight commands, including compilation and validation, in the configured remote command pool even with `includeLocal: true`. The controller does not compete by load for these classes; lightweight commands still honor `includeLocal`. Busy workers retain the existing remote admission/reselection flow. Explicit local placement and configured local fallback when workers are unreachable retain their existing admission rules; this does not require a per-session execution config.

Heavyweight ranking adds normalized CPU load to the selected class envelope divided by observed unreserved memory (available memory on Darwin). This compares actual headroom for the command rather than each worker's percentage of free RAM, so larger workers are not penalized solely for having more total memory. Existing class-capacity checks, live admission, warm compiler affinity and runtime platform preferences still apply.

Selection excludes machines whose total RAM is below the selected class's requirement. Linux/WSL admission subtracts only each live admitted job's unused reservation, `max(0, class envelope - authenticated process-tree memory)`, from available memory: resident pages are already absent from `MemAvailable`. Missing memory observation retains the full reservation. There is no additional guessed available-memory percentage, PSI or CPU-load denial. Reservations remain until exit or proven-dead owner reclamation; authenticated descendants reuse their parent's reservation, and escalation replaces that owner's envelope under the admission lock while crediting its existing resident memory. Explicit `--local` bypasses remote placement and uses this same admission against local memory. Light local commands remain immediate. Diagnostics name available, required and unused reserved memory. The envelopes reserve admission headroom but do not cap a command's actual memory use. Runtime publication placement uses the retained-demand broker described below; busy admission keeps the build remote, and only unavailable capable workers permit configured local fallback. Darwin selection applies the total-capacity filter and load ranking; its existing execution path has no admission queue. Native Windows command routing remains local.

In current 0.3 development source, the canonical Linux observer uses `/proc/<pid>/smaps_rollup` PSS for admitted trees so shared pages contribute each process's share. Service/browser memory is diagnostic: its resident pages already reduce OS `MemAvailable`, and its census never supplies another capacity deduction. Native admission can report a summed service RSS upper bound without walking those services' page tables; admitted-owner credits retain proportional accounting. Process metadata is observed once for the executing account, and kernel generations are read without per-PID subprocesses. Vanished processes contribute zero rather than stale RSS; unreadable or malformed PSS for a live process falls back to RSS and reports the accounted fallback PIDs. When neither observation is available, admission retains the full reservation. Historical RSS peak measurements above remain measurements of the original runs.

In current 0.3 development source, the Linux worker fixes admission state at `/tmp/happier-heavyweight-admission-v3` and derives machine identity from the OS. The root's protocol revision must change when waiter/owner semantics change, keeping incompatible launchers in separate queues. Revision 3 adds lease availability to queued publishers so a lease-blocked head yields priority. Caller roots, homes, temporary mirrors and target aliases share the queue for their revision. The configured worker execution account owns that directory; unavailable or foreign-account state fails closed rather than falling back to a private root. Authenticated live owners in other roots retain their unused memory reservations through process-tree observation, and authenticated ancestors reuse their existing envelope on reentry. Queue heads identify themselves by pid and kernel start token rather than waiter path. Already-loaded older launchers remain in their original queue and require owner-controlled reinvocation if stranded; atomic source replacement cannot update their parsed program.

If remote admission cannot register its state before payload execution, the admission owner emits an execution-qualified failure. Automatic placement excludes that worker for the existing unavailable-probe TTL and tries another configured target; an explicitly pinned invocation reports the failure without changing hosts. Preparation failures and a started payload's exit status, including 75, are authoritative and never request replay.

In current 0.3 development, AUTO checks dispatcher-owned payload admission without waiting after preparation and before payload execution. An execution-qualified busy result releases that dispatch reservation and re-evaluates the remaining pool without an unavailable-host TTL. If every usable worker is busy, the selector waits using the admission pressure-retry cadence and re-evaluates the pool; it does not fall back locally merely because workers are busy. Heavy Linux candidates also rank using the admission owner's unreserved memory budget, including service memory and unused live-owner reservations; a budget below the command's class floor ranks behind fitting workers. With `includeLocal`, local ranking also adds live waiters from the current admission root divided by CPU capacity to its effective load, alongside active dispatches; stale process incarnations add no penalty. Explicit pins retain the worker's observable admission wait. Existing already-loaded launchers are not restarted or moved by this source change.

POSIX compilation-class dispatch in 0.3 development keeps project locality at this same
AUTO selector. A repeated project scope prefers its most recently completed worker
when the current sample can admit immediately; dispatcher-certified busy admission
falls back to ordinary pool selection, including bare canonical TypeScript
commands. Finite publishers and the compiler leaves of producer-containing
lifecycles instead wait through their own admission transaction on the selected
host, without an outer reservation across prerequisite production. Each invocation completes its own causal synchronization
barrier and runs through the existing heavyweight admission. The native compiler
remains authoritative for incremental currentness. There is no input-equality
scan, shared in-flight result or completed-check cache.

The root `build:packages` coordinator follows this producer-owned admission path.
Its existing workspace graph prepares transitive producers through their joint
publication-lease and capacity owner. Dispatch retains the compilation placement
envelope without reserving capacity around the coordinator, so a foreign producer
lease can settle before admission. Admitted descendants still cannot wait for
foreign publication leases.

Remote development service readiness and QA-browser forward readiness have no
automatic overall startup deadline. They follow their owning process/user
cancellation and exit lifecycle; positive explicit service-readiness options
remain operator choices. Mutagen project mutation still uses its canonical
exclusive lock, without a competing acquisition deadline. Remote cancellation
confirmation similarly has no separate ten-second command cutoff.

In current 0.3 development source, browser workers retain their signal handlers until their detached agent-browser session and temporary profile are closed. Controller loss follows the existing stdin lifeline; browser custody sends `close` through the existing control channel and awaits that cleanup rather than applying the generic two-second group cancellation. Stack stop retires exact Stack-name/env-file/browser-kind bindings locally and on configured POSIX targets, even without runtime state. It closes workers before sweeping remaining orphaned browser processes. An unavailable target leaves browser retirement unconfirmed, reports `browser_cleanup_unconfirmed:<target>`, and allows stop to proceed. A reachable target reporting browser cleanup failure still prevents finalization. This does not authorize another Stack's processes or a controller-local fallback.

Remote Stack retirement in current 0.3 development uses the canonical trusted-process lifecycle owner when a runtime record survives a reboot; a retained file does not prove its recorded processes are alive. The existing legacy Expo-state probe still blocks retirement while a recorded Expo process survives. After a failed or interrupted stop, including one with no exit status, a fresh absence probe can confirm retirement. Surviving processes or unreadable membership remain unconfirmed and block completion.

Runtime builds prepare and upload captured source before creating a native runtime-build owner or waiter. Source-transfer PREPARE/ACK precedes, and does not replace, actual admission READY. Once source is ready, builds retain one original worker demand while native AUTO checks alternatives on that same cadence. Each alternative refreshes command capability, synchronization and load rather than reusing unavailable or load caches. A selected alternative still flushing does not stop checks of other workers; its channel stays alive and its worker is excluded from concurrent selection until actual admission or failure. Only actual READY releases the original demand. Daemon builds prefer eligible native OS/architecture workers over supported cross builders; server/web placement keeps load-based ranking. Busy native workers still allow later cross-builder admission.

Every native admission resource check reclaims owner and waiter records whose process generation is proven dead, including pressure-denied readiness probes and inherited escalation. Live records remain queued; reclamation adds no age deadline and never signals a process.

Linux worker disk admission uses `worker_disk_budget.mjs` to observe free bytes on
the command's known write filesystems. It refuses an already exhausted filesystem;
resident dependencies, caches and retained outputs do not establish additional writes,
so there is no disk-envelope reservation or guessed build peak. Exhaustion triggers
ordered custody reclamation (oldest stale staging across stacks, unneeded pnpm entries,
stale lane scratch). Explicit maintenance can run that retention policy independently.
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
A still-exhausted worker is excluded before bootstrap/payload; pins report the disk
diagnostic. The execution-qualified disk marker never authorizes replay of a started
command. `dev-targets status` exposes free bytes. Admission does not guarantee capacity
for future writes or filesystem quotas; real write failures remain authoritative.

Linux/WSL waiting messages and `dev-targets status NAME` expose authenticated admission holders' class, PID, process age, phase and approximate recent process-tree CPU use. Newly created native owners start at `admitted`; a runtime worker reports `awaiting-runtime-request` before its build ACK and `building-runtime` after it. The awaiting phase includes producer publication-flight waits after actual admission; `building-runtime` does not imply CPU activity or rule out internal lock waits. Phase is diagnostic only and never changes the reservation. Older loaded owners without the optional field report unknown; their record lifecycle is unchanged. The existing service-memory observer owns this read-only projection. Waiters reuse their preceding cadence sample; status takes a second sample at that cadence when holders exist. CPU counters have one-second resolution, unavailable evidence is reported as unknown, and zero recent CPU is not a hung verdict. Observation never imposes a holder deadline or kills work.

An explicit routed `hstack-exec --heavyweight-admission --class=... -- ...` carries its class into this same placement policy before committing to a worker. Payload flags after the delimiter do not change the envelope. Native memory observation uses the existing native process-identity owner without installed workspace dependencies, so fresh mirrors can enter admission before their first dependency bootstrap.

Stack unit roots, CLI default test homes/bins, external-hook configuration fixtures and docs-check fixtures use `scripts/testing/process/temporaryDirectories.mjs` for normal teardown. On Linux, custody's explicit `reap-test-temp-roots` mode can reclaim marked roots after their creator, process group and explicitly bound descendants are gone. Detached children inherit `HAPPIER_TEST_TEMP_ROOTS`; inaccessible ownership observations retain the root. Ordinary command dispatch does not sweep shared scratch. In current 0.3 development, explicit `reap-temp-roots` maintenance checks historical `happier-*`, `hstack-*`, `docs-check-*` and Yarn v1 `yarn--*` directories beneath the selected temporary parent. It reclaims only account-owned, non-symlink roots whose newest descendant mtime is older than 24 hours and which no live same-UID process uses as cwd, open descriptor, mapped file or inherited temp binding. For a known same-UID process denied by procfs dumpability, the historical reaper retries read-only observation through existing noninteractive `sudo` authorization. It never exempts a process by name, changes OS authorization, or elevates deletion. Unknown UID or still-unavailable same-UID visibility retains candidates; processes whose status identifies only foreign UIDs do not block this user's reclamation. Environment contents and privileged command output are never logged. The 24-hour margin does not limit admission waits. Reclamation logs paths and allocated bytes, counting hard-linked files once. Invoke historical maintenance through target-specific execution of `bash apps/stack/scripts/utils/dev_targets/remote_execution_custody.sh reap-temp-roots - historical-sweep`, with an explicit `TMPDIR` for a shared parent; it never signals processes.

Service placements do not exclude command hosts. OS available memory already accounts for current server/Expo/daemon/browser processes. Admission subtracts only unused admitted-work envelopes from that available memory; a service RSS estimate with shared-page overcount cannot block otherwise fitting work. Active builds retain their `runtime-build` class reservation. Diagnostics expose service memory and unused command reservations; no second placement list exists. A class larger than total physical RAM fails immediately with a remote-routing instruction. A fitting class waits for available capacity rather than treating a currently resident service as permanently reserved growth.

Fitting work can backfill a capacity-blocked queue head. There is no existing admission deadline: cumulative backfill is instead bounded by that head's existing class envelope, and stops when a candidate envelope would bridge its capacity gap. Successful admissions alone consume this allowance; failed attempts and readiness probes do not. Equal-or-larger queued classes cannot backfill and are rejected before resource observation, so they do not serialize unnecessary process scans ahead of the head. Plain and workspace capacity-lock acquisitions block in the same kernel `flock`, including AUTO's `--no-wait` contenders: mutex contention preserves their worker and queue age rather than restarting placement. `--no-wait` still refuses a completed queue or capacity decision; inherited lease holders also refuse mutex contention to prevent lease/admission inversion. Readiness probes remain nonblocking. Active-owner diagnostics use the same process-generation and surviving-tree liveness check as memory reservations; leftover custody FIFO directories do not count as workloads. Lease-blocked publishers yield head priority until a nonblocking lease attempt succeeds, so a lease holder can obtain admission without a cycle. The existing cadence still applies after a queue or pressure decision. This prevents an endless stream of small commands from starving a ready head, without adding a timeout or fixed job-count ceiling. Admission cannot make unavailable physical capacity appear.

Capacity exclusions are invocation-specific: healthy raw samples remain usable by focused work on smaller workers and retain the default 15-second positive probe TTL. Dependency-refresh waiting belongs to the bootstrap's workspace lock before payload admission, within the same cancellable target execution. A selected sync-flush failure retries another target before any command starts; if reachable targets have synchronization or prerequisite failures, the launcher reports an actionable error. Configured `fallback=local` applies only when no remote target is reachable, with an explicit log. Explicit `includeLocal` participation, local placement and machine-local invocations remain distinct from fallback. Exit 137 remains authoritative and reports possible OOM with the last target memory sample; it is never automatically replayed. Outbound routing requires a cwd inside the synchronized repository; explicitly local publishers and already-placed children may use temporary repositories.

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
retirement belong to the routing sync service. A failed resume does not restart
the shared daemon. Execution-host candidates are separate producers: each legacy
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
Sibling command settings live only under the producer's `commands-<checkout>/dev-targets.json`;
target definitions derive from the producer, and service endpoints derive from
the sibling's own Stack config. Mac mirrors require a current Mac-only flow, not withdrawn
exact-target typechecks alone.

`mutagen_runtime.mjs` owns first-cycle readiness, including its generated `native_sync_readiness.sh` projection. A clean connected idle session with both endpoints in `no-watch` and no completed cycle is `needs-flush`: eligible for selection, with the mandatory dispatch barrier establishing a completed clean cycle before any payload. An active initial scan remains `synchronizing`. Status and doctor read the same classification; startup seeding also consumes it rather than deciding independently from watch/cycle fields.

Known scan races (`hashed size mismatch: <bytes> != <size>` from Mutagen 0.18.1)
and transition races (file modification during validation, a disappearing leaf,
or a missing staged file during permission application) request one fresh flush
through the same barrier, including before the first completed cycle. Startup
uses that barrier too. Native and Windows consumers use the same readiness
policy and retain the existing flush retry and timeout. Recovery never
admits a payload until a fresh inspection is clean; persistent, unknown,
excluded or permission-denied scan and transition problems remain unhealthy.

Managed worker enrollment and automatic command placement attempt to disable sleep through `dev-targets power no-sleep NAME|auto`. Ordinary unmanaged SSH enrollment requires explicit `host prepare --no-sleep` or `power no-sleep`. Managed workers apply the same policy to their outer host and Linux guest. Windows disables AC/battery idle and unattended sleep, idle hibernation and lid-triggered sleep; macOS disables idle system sleep; Linux masks systemd sleep targets. Manual targets are excluded from automatic placement setup. An existing Windows machine policy enforcing zero satisfies that setting; conflicting policy remains an error. Administrator privileges are required, and denied settings are reported without blocking worker enrollment or changing placement. The explicit power command returns failure for incomplete configuration. These defaults belong to worker setup, not ordinary Happier installation on a personal computer.

In 0.3 development, Windows worker setup also installs the machine-wide `Happier-Worker-Power` task under SYSTEM, with boot and logon triggers and no execution deadline. Its administrator-protected script reapplies and verifies the same settings at boot and holds a named system power request. The existing per-user WSL task owns guest startup separately: running WSL alone does not prevent Modern Standby. The request keeps an AC-powered worker active while allowing its display to turn off. Windows limits power requests on battery and honors explicit user sleep; keep an unattended Modern Standby worker on AC. See Microsoft's [Modern Standby software preparation](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/prepare-software-for-modern-standby) and [power-request limits](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powersetrequest).

`dev-targets status NAME` reads power health for the host and guest alongside synchronization and runtime health, including effective Windows machine-policy overrides, the boot task and active power request. An unhealthy or unavailable power observation makes status fail without changing synchronization state. On macOS, incomplete idle-sleep policy reports the one-time host command `sudo pmset -a sleep 0`; Linux health requires all worker sleep targets to remain persistently masked. Power verification belongs to `worker_power.mjs`; status does not apply settings.



In 0.3 development, `apps/stack/scripts/utils/dev_targets/remote_commands.mjs` owns command classification; the native launcher consumes its generated `native_command_policy.sh` projection rather than maintaining another classifier. Native `node --test` commands receive installed-dependency readiness. Only source-proven test commands bypass workspace publication; unknown native commands retain component preparation. Stack dependency-closure publication is reserved for Stack validation, not every remote command. Default CLI/UI and cli-common Vitest configurations resolve workspace source; default UI tests use the typed empty bundled-app inventory fixture, while `vitest.artifact-cache.config.ts` retains generated inventory and artifact preparation. Workspace build currentness remains owned by the dependency-closure/fingerprint path; there is no separate `prepare:build-inputs` hook.

CLI tests that copy or natively import physical public SDK packages run in `vitest.integration.config.ts`, through the same canonical workspace preparation. This includes public-authoring activation, cross-copy `PluginError`, lone-file SDK resolution, scaffold compiler/UI journeys and prepublication author installs and packs. Current-source catalog and RPC compositions that activate workspace Agent modules use `apps/cli/vitest.source.integration.config.ts`. It reuses the integration lane's resolver, aliases, includes, pool and environment, with source-only setup: native process custody is prepared, while provider declarations come from the tracked manifest projection and activation loads the real development modules. CLI unit setup uses this same source role. Compiled CLI modules, including `dist` in a source checkout, still admit distribution publication failures; packaged and unknown roles retain fail-closed inventory checks. Source imports do not satisfy fixtures that consume copied package trees or prepared CLI subprocess outputs. Temporary filesystem/process fixtures that produce their own inputs remain source-owned.

Run a source integration slice through the canonical wrapper, for example:

```bash
./apps/stack/bin/hstack-exec -- pnpm --dir apps/cli run vitest:local run --config vitest.source.integration.config.ts src/api/apiMachine.preflightCatalogs.runtimeCatalog.integration.test.ts
```

The wrapper recognizes this exact CLI source configuration and retains normal validation admission and installed-dependency readiness. Other custom configurations retain workspace preparation.

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

In current 0.3 development, start a remote fake-audio QA browser with `hstack dev-targets browser start <lane-session> --stack=<qa> --url=<qa-ui-url> --fake-audio=packages/tests/fixtures/voice/phrases/short-command.24k.wav`; the checked-in speech says “Open the project settings,” is copied into the worker-owned profile, and still requires microphone permission (bare `--fake-audio` supplies Chromium's synthetic device instead).

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

The repository deliberately separates the compiler from the programmatic TypeScript API:

- In 0.3 development, pinned `tsrs` handles typechecks, including internal declaration partitions and routine CI, on Linux x64/arm64 and macOS arm64. `@typescript/native` provides Microsoft TypeScript 7.1.0-beta for builds/shipped declarations, release validation, editors, Windows and Intel Mac; Microsoft remains the final diagnostic authority. Set `HAPPIER_TYPESCRIPT_COMPILER=microsoft|tsrs` for typechecks (`auto` restores selection); builds and watch/tooling stay Microsoft. Missing binaries and compiler failures propagate without fallback. Tsrs incremental caches, internal declaration outputs and reference projections use `.tsrs`, preserving the Microsoft graph consumed by prepared CLI builds.
- `typescript` remains the TypeScript 5.9 API consumed by AST tooling and ecosystem integrations. Do not replace it with TypeScript 7 until the native release provides a stable compatible API and every consumer supports it.
- `scripts/workspaces/resolveTypeScriptCliInvocation.mjs` is the only compiler-selection owner. First-party scripts must use `runTypeScriptCli.mjs`, `buildTypeScriptPackageDist.mjs`, or that resolver directly; do not invoke a bare `tsc` shim or resolve `typescript/bin/tsc`.
- `pnpm run tsc ...` is defined at the repository root and in every TypeScript-owning workspace; it delegates to the same selector and runner.

CLI typechecks run `tsconfig.foundation.json`, `tsconfig.services.json`,
`tsconfig.core.json`, `tsconfig.source.json` and `tsconfig.test.json` sequentially
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
services, core, source and tests. Their package entrypoints must pass those complete
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
unrelated workspace closure. Component typecheck preparation does not rebuild
dependencies; the compiler reads their published declarations and emits its own
project declarations. Ordinary strict publication retains its live-input fence.

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
- CLI runtime import cycles are fail-closed: update the baseline only for known debt, and keep `pnpm run test:import-cycles` wired through the root script and `@happier-dev/cli` unit lane so CI exercises it with CLI tests.
