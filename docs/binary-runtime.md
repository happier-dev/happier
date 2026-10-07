# Binary-Safe Runtime and Bundled Workspaces

Happier ships binary installers. First-party runtime paths must work on machines that do not have system `node`, `npm`, `npx`, `pnpm`, `yarn`, or `bunx`.

## Runtime contract

The daemon owns Plugin UI compilation and invokes the SDK's bundled esbuild
implementation from the published workspace dependency closure. Shipped hosts
do not spawn Vite, Re.Pack, Metro, Node, or a package manager to load a plugin.
They evaluate the verified CommonJS bytes in the app realm through the fixed
host-module map.

Do not introduce direct product-runtime calls to:

- `spawn('node', ...)`
- `npm`, `npx`, `pnpm`, `yarn`, `bunx`
- shell installers from UI/daemon/runtime code
- PATH-only agent/runtime detection as the sole source of truth

These are allowed only behind centralized managed runtime/tooling abstractions.

In 0.3 development, remote SSH machine setup installs the selected CLI through
the canonical first-party payload installer after host trust and before relay
installation, service inventory, or Home enrollment. SSH command execution and
both payload strategies share the path-quoting owner in
`packages/cli-common/src/ssh/shellQuote.ts`: only the leading `$HOME` expands;
the remaining path and caller-supplied command arguments stay literal.

Before adding or changing an agent runtime, managed dependency, install, or update flow, classify it as one of:

- system-first agent CLI
- managed-first internal prerequisite
- managed package
- vendor install recipe
- managed JS-runtime dependent

Agent detection, install status, daemon validation, runtime spawning, and UI/managedDependencies must reuse the same source of truth. Agent CLIs should prefer user/system installs by default over Happier-managed installs unless an explicit setting says otherwise.

In current 0.3 development source, Pi's vendor-managed launcher is a system-install
candidate declared by its plugin: `PI_CODING_AGENT_DIR/bin/pi`, then
`~/.pi/agent/bin/pi`, when `PATH` has no matching executable. Explicit
`HAPPIER_PI_PATH` remains exclusive and the existing Happier-managed source
preference remains authoritative. Detection, version probing and launch consume
the shared Agent resolver; the vendor launcher owns its pinned Pi release and
JavaScript runtime environment.


In 0.3 development, Agent install/update jobs wrap the canonical managed installer
in the daemon; browser, phone, and dedicated CLI callers submit to that same owner.
Vendor recipes stay inside this abstraction and require explicit consent. Managed
package acquisition uses the managed pnpm selection/bootstrap owner: if no usable
managed or explicit override command is available, it fails rather than falling
back to `pnpm` on `PATH`. See
[Agent install and update jobs](./agents-catalog.md#agent-cli-install-and-update-jobs-03-development).

One request-scoped exception exists: `AgentCliSourcePolicy` (`packages/cli-common/src/agents/resolution.ts`). Passing `sourcePolicy: 'managed_only'` to the canonical resolver, install preflight, or `prepareAgentCliForRuntime(...)` restricts that single request to the managed install under its own `HAPPIER_HOME_DIR`: environment overrides, system/global installs and vendor recipes are ignored, and a retry may reuse a valid current managed install. It is a per-request argument, never a persisted or environment-configurable preference, because a composition that may run only what it installed itself (the temporary-computer Runner) must not be widened by the endpoint's environment. Such a composition passes the returned resolution unchanged into the launch through `buildAgentCliLaunchSpecFromResolution(...)`; resolving again at launch would let an override or system binary substitute itself between readiness and launch.

Model Provider endpoints are not Agent executables. Provider discovery may use only the bounded detector and local-command declarations owned by the Provider contribution and the canonical local-services/runtime abstractions. An adopted local service is observed but never stopped or restarted by Happier. A Provider process started through the managed-local-service path is owned by that path; Provider code must not spawn `node`, package managers, or vendor commands directly. See [Providers](./providers.md#local-discovery-and-process-ownership).

## Development/QA first-party release mirror

In current development source, QA can set `HAPPIER_FIRST_PARTY_RELEASE_API_BASE_URL` to an
HTTP(S) origin on `127.0.0.1` or `[::1]` when `NODE_ENV=development`. The existing first-party
release resolver uses that origin for GitHub-shaped tag metadata; metadata supplies the asset URLs.
Paths, URL credentials, queries, fragments, malformed values and non-loopback hosts are rejected
visibly. GitHub tokens are never sent to the mirror. Build the QA hsetup with
`NODE_ENV=development node apps/bootstrap/scripts/buildBinary.mjs` after building its dependencies;
normal builds freeze `NODE_ENV` to `production` and reject the override even if the launched
process sets `NODE_ENV=development`. This is a development/QA seam, not a released setting.
The mirror must serve the publisher's unmodified archives, checksums and minisign signatures:
the existing checksum and official-public-key verification is unchanged, with no environment key override.
The vendor-owned, exact-version Mutagen engine follows its existing separate acquisition contract.

## Internal workspace packages

Private workspace packages such as `packages/protocol`, `packages/agents`, `packages/cli-common`, and `packages/release-runtime` are not published independently, but they must ship inside published npm packages that import them at runtime.

Published hosts and bundled libraries currently include:

- `apps/cli`
- `apps/stack`
- `packages/relay-server`
- `packages/support`
- `packages/plugin-sdk`

Their `prepack` scripts run `scripts/bundleWorkspaceDeps.mjs`, which delegates to `bundleWorkspacePackagesWithRuntimeDependencies(...)`. That canonical publisher stages each workspace together with its external runtime dependency tree and publishes the internal dependency closure in dependency-first order.

Current source bundling preserves package-local `imports` declarations and their conditional order, alongside `exports`. The existing workspace copier and bootstrap sync include exact relative import targets outside `dist`; external package targets still use the package's declared dependency closure. Live bundle health checks compare the retained import map and target files, and Stack bundle freshness observes package-root targets so changing only an imported runtime helper requires a refresh.

Publication has two explicit modes. Live source-dev refreshes keep each physical consumer package directory mounted, publish complete files with `package.json` last, retain prior targets for in-flight module resolvers, and roll back already-published files if a later replacement fails. A consumer workspace symlink or junction is replaced with a private directory rather than publishing through it into producer inputs; failed publication restores the link. Artifact publication is selected by npm `prepack` or `--artifact` and prunes retained targets so obsolete generations cannot enter a tarball. Both modes use the package build owner's content record to admit current `dist` outputs, including source additions and deletions, build inputs, compiler identity, and declared output bytes. Health checks require every current source runtime file to match but deliberately allow extra retained targets in live trees.

In 0.3 development, the same package admission owner distinguishes compilation
from runtime materialization. A dependency's declarations (`.d.ts`, `.d.mts`,
`.d.cts`) and package resolution surface invalidate compilation, including
declarations reached through other internal dependencies. Implementation-only
dependency edits refresh bundled workspace copies and declared Plugin UI bundles
without entering dependent compilers. Full dependency bytes remain in the existing
build record: changed bytes run the package's prebuild projection checks and,
where declared, its `build:ui` output phase. Output refreshes retain the existing
package locks and staged publication. The root preparation
adapter and source-dev synchronization publish refreshed plugin outputs through the
existing projection owner, just as they do newly compiled outputs.

Workspace preparation and bundled-plugin generation share one bounded convergence
owner. Development-only source server admission, CLI/daemon shared-dependency
publication and UI preflight default to `source-dev`: compile in place, with the
existing staged output promotion, input-drift fence and last-green fallback.
Like QA emit, source-dev records unchecked output as `qa-runtime`; strict and
publication lifecycle builds still require checking. Explicit QA/runtime publication
continues to select `qa-runtime`, where compilation and runtime-output refresh use a physical
capture of the package inputs and consumed dependency outputs. Capture copies each
member once, then rereads only members changed during that pass, at most once.
There is no quiet-checkout requirement after those trailing reads. Successful output
records the captured fingerprint; later producer edits leave that output stale for
the next preparation request rather than rejecting completed compilation.
Captured workspace builds reuse the source checkout's installed dependencies.
The shared runtime-dependency containment owner accepts that source repository
only for the active capture's repository-wide copy boundary, using physical paths
for both roots. Package-local boundaries and foreign symlink targets remain rejected.
The capture owner also records its immediate physical source repository separately
from origin identity, so worker or nested captures can consume their actual installed
dependencies without reinterpreting the origin-normalized build fingerprint.
Source-dev CLI publication can consume captured non-plugin dist certified by the
package admission owner even after later source edits, but does not stamp it current.
Plugin projections retain their authored-manifest coherence fence.
Strict builds retain their moving-input fence. When their inputs move during a successful package build, preparation retains the
last coherent output and takes one trailing pass through declaration-level package
admission. Completed unchanged packages are reused; only stale compilation or
runtime materialization runs again. Continued drift fails with a typed exhausted
result unless the development last-green policy admits a coherent retained output.
Outside that policy, compiler and projection-command errors fail immediately, even when source
also changes; exhausted workspace failures and command failures retain their
classification across the generator's private child IPC and cannot trigger another
generator retry. The previous output is never certified as current after rejection.

In 0.3 development, runtime artifact publication selects `qa-runtime`, while
source-server dependency preflight, CLI source-dev dependency publication and
live UI workspace prebuild select `source-dev` at the same workspace package-build
owner. TypeScript package dist refreshes in both modes use incremental `--noCheck` emission instead of
repeating the full semantic checker. Checked and emit-only compiler options have
separate existing cache identities; the existing output record carries build mode,
and strict requests recheck QA-mode outputs rather than treating them as checked.
Release lifecycle selection stays strict. A failed TypeScript
compile may use that package's retained output only when its existing build
record, declared outputs, local import graph and dependency provenance remain
coherent. After the single trailing pass, continued input drift during compilation
or runtime-output refresh may use the same coherent retained output. Missing or
damaged output, syntax errors, process failures and failed refresh commands do not grant fallback.
The existing record carries the compiler or drift diagnostic and last-green build time;
component and snapshot manifests carry each stale package's record and output
identity. Artifact identities include the consumed stale outputs, including
daemon support, so a compiling replacement receives a different identity.
`stack info` and publication-flight results expose staleness. Ordinary builds
default to strict mode, and release publication forces strict compiler children.
Cold source starts and reloads can therefore proceed using coherent retained
dependencies during a mid-edit compile failure or continued input drift. The last-green warning and source-dev
CLI warning include the stale package and diagnostics in startup/TUI logs;
`stack info --json` projects local dependency records in
`runtime.sourceWorkspaceStalePackages`, and human output includes their last-green
time and diagnostics. Remote or borrowed workspace observations are `null`, not
a claim that those outputs are current; their startup logs carry the warnings.
This source-workspace observation is separate from loaded snapshot metadata.
A source correction invalidates admission and the next refresh compiles and
publishes fresh output, clearing the existing failure record. Explicit strict
requests cannot reuse a source-dev materialization stamp to skip a failed compile;
UI artifact prebuilds remain strict even with an inherited QA environment.

Bundled-plugin authoring preparation admits a dependency publication through
the same package build records and exact source-to-installed output checks.
A coherent QA capture published after newer source arrives remains usable even
when the source-dev owner deliberately withholds a current-source readiness
stamp. That admission does not stamp newer source current or replace the
generator's subsequent dependency-currentness fence; missing, damaged or
uncertified package outputs still fail admission.

The repository background snapshot publisher explicitly selects `qa-runtime`
before component resolution and child-process bootstrap, matching manual QA
artifact builds. The CLI's explicit `qa-runtime` build overlaps TypeScript
checking with pkgroll only when the native admission owner's live memory sample
covers its measured runtime-build envelope. Below that envelope, or without a
usable memory observation, checking finishes before pkgroll starts. Plugin
preparation finishes before either phase. The build log names the selected mode
and memory sample; this is a concurrency choice, not another queue or reservation.
Semantic TypeScript diagnostics warn and publish current bundled JavaScript in either mode;
the existing QA degradation list records their summary, count and source files
in the CLI, daemon component and snapshot manifests and `stack info`. Syntax diagnostics, compiler
process failures and bundler failures still abort, and strict/release builds
must pass checking and cannot reuse a CLI dist carrying QA errors. Diagnostics
do not change the runtime content identity when emitted bytes are identical.

Bundled-plugin publication reuses its existing successful completion record
before preparation only when authored inputs and produced outputs are still
exact. Missing or changed output requires publication again; failed completion
records never suppress an independent retry. The CLI preparation key follows
the existing plugin-authoring import closure and package/compiler configuration;
an unrelated CLI runtime edit does not invalidate plugin preparation. Generated
CLI/UI projections and plugin outputs have separate currentness checks at their
existing publishers. First-party plugin compilation
reads authored manifests, so changing the generated `plugin.json` alone does
not enter its compiler. Shipped-artifact integrity still observes that file.

All workspace/package publication that shares the CLI dist path uses the canonical cli-common lock implementation. Development waiters continue while an authenticated owner's heartbeat is fresh, even beyond the elapsed contention budget; the existing staleness policy governs owner recovery, while unknown or unreadable owners still have a bounded wait. Nested build processes inherit an owner-authenticated lease containing both the normalized path and a random owner token; a path alone never proves ownership and cannot bypass a successor process. Publication and the prepared consumer that reads the published graph are one locked transaction: reconciliation replaces the dependency tree entry by entry, so a compiler, API-surface, or prepack reader released early could resolve one module from the new generation and its import target from the previous one. The prepared consumer therefore runs inside the same held lock and receives that lock's lease, which is what lets a prepared script that republishes the graph itself — `prepack` — reenter instead of waiting for its own owner. Dependency builds preserve that lease but remove the parent package's staged-output override so one workspace cannot compile into another workspace's publication directory. If compiled cli-common helpers are unavailable during bootstrap, the repository sync script stages and vendors a complete package off-path before publishing it, and propagates failures without modifying the previous live package.

The bundled-plugin generator prepares dependencies before acquiring its publication lease. The source CLI's cold-entrypoint adapter delegates shared dependency preparation to its canonical build owner without holding an outer shared-copy lock across generator children. That owner acquires the shared-copy lock for publication; the later CLI runtime build retains its separate writer lock. In current development source, the private Agent-facts child consumes the parent's admitted dependency signature through the existing prepared-publication payload instead of repeating preparation. It acquires its own short write lease; the parent does not hold a lease across the child. Early facts read authored Agent definitions and CLI/native-home metadata without inspecting unrelated UI, prompt or Account projections. Manifest publication precedes selected-plugin preparation, and final projections retain the existing coherent output transaction. The shared dependency owner's signature is rechecked after lock admission and at the output commit. When a preparation or publication child fails and its consumed dependency fingerprint changed, the canonical request owner takes its existing single trailing preparation pass outside admission; package currentness retains unchanged outputs. Failures against unchanged inputs and failures on the trailing pass still propagate. Existing caller-owned leases remain authenticated and cannot be released by the child. Lock acquisition and release also retire expired or proven-dead priority-claim quarantine snapshots and the releasing owner's own snapshots; live or inconclusive claimants remain recoverable. An inconclusive acquired-claim cleanup is deferred to release without failing admitted work; a vanished recovery snapshot causes admission to reobserve ownership before retiring remaining history. Priority claims retain the existing continuous-waiter starvation protection. A waiter's result-reuse check runs after lock admission under the owner's heartbeat, so a slow currentness probe neither loses its handoff priority nor reads outputs during another publisher's replacement.

In current development source, CLI bundled-plugin preparation admits its complete selected workspace graph through the package build owner once. That owner shares dependency admission, concurrency and optional plugin failure isolation; a required shared dependency failure still aborts preparation. Generator progress reports publication reuse reasons and each package's skip, rebuild or failure decision with its duration and invalidation reason. These diagnostics distinguish source or output changes from repeated preparation work without adding another cache or publisher.

The stack pack sandbox copies the shared workspace scripts, materializes the complete internal build-tool workspace closure, and links the repository's installed root dependency tree for external build-tool resolution. Build-time workspaces remain separate from the package's declared runtime bundle closure, so tooling-only packages cannot leak into the tarball. The root dependency link is outside the packed package root and is removed with the sandbox.

`packages/support` is the library precedent for this pattern. `packages/plugin-sdk` follows the same doctrine: its packed tarball bundles the internal workspace closure needed by its public declarations and runtime helpers.

## Source, managed-runtime, and release boundaries

The same source tree serves four deliberately different policies:

The live/artifact workspace publication modes described above concern package source outputs and
their dependency closure; they are not managed runtime-snapshot publication.

In current 0.3 development, Stack daemon commands execute the launch command
admitted by the runtime snapshot, including profile reconciliation before startup.
A snapshot's separate Node entrypoint remains available for dist-closure inspection
and provenance; it does not replace an admitted native launcher. Source launches
without an explicit command still use the managed JavaScript runtime.
Explicit-runtime Stack start, daemon lifecycle and CLI commands consume their
admitted snapshot without first preparing the moving source workspace. Source
commands retain the existing workspace preflight.

Detached daemon launch from an admitted JavaScript closure runs the existing
managed JavaScript-runtime bootstrap before resolving that child, including when
the foreground launcher is native. It retains the admitted closure rather than
reusing an unrelated incumbent runner or requiring system Node.
Subprocess executable resolution uses the same requested environment as closure
admission, including its Happier home and explicit runtime selection; a detached
or successor launch does not borrow the parent's runtime selection.
Bundled-plugin custody also recognizes a Stack snapshot's daemon artifact. The
CLI custody owner resolves the snapshot's `cli` link to the physical
`artifacts/daemon/<fingerprint>/payload` root and binds its identity to the
producer manifest's component, payload directory and artifact fingerprint.
Native and JavaScript launches share that exact artifact identity. Managed
installation pointers retain their canonical version-marker checks; Stack
artifacts do not require or manufacture managed-install markers.
On Linux, Stack's listener observer prefers the kernel socket table (`ss`) for
exact-port PID evidence instead of scanning process files with `lsof`. Existing
ownership verification remains authoritative; missing process identities are
inconclusive. Process-group probes and hosts without `ss` retain `lsof`, and
Windows retains its `netstat` adapter.

- Source validation reads authored source and checked-in/generated compiler inputs. Typechecks, ordinary tests, lint, and searches do not publish CLI, server, UI, daemon, plugin, runtime-snapshot, or runtime-support artifacts.
- Source development starts from any valid last-green output when one exists, then refreshes changed source outputs in the background. For a checkout-derived repository producer, successful non-destructive server/daemon preparation requests publication through the canonical runtime publisher before the separately generation-fenced live activation; newer edits can therefore defer a service restart without discarding useful completed bytes. One publication runs at a time and later requests coalesce into one trailing identity recomputation. A full restart reconciliation compares web, server, and daemon identities. A failed publication leaves the current snapshot selected and source services unchanged, while its phase is written through existing runtime state.
- Managed named-stack publication probes the existing component source/toolchain identities and artifact manifests before bundled-plugin preparation. When every selected web/daemon artifact matches, bundled-plugin preparation is skipped. A web or daemon miss uses the canonical selected preparation closure and then recomputes identities after generated-input writes. Publication builds only the requested runtime component(s), reuses unchanged component artifacts and owner-specific support artifacts, and commits a complete runtime snapshot whose component paths reference canonical producer payloads. A consumer selects that snapshot; it does not build or copy a second payload, and selection does not restart a running process.
  Web identity includes the projection producers and their build inputs. The bundled-plugin generator owns its authored-source closure, including esbuild-resolved transitive imports; web and daemon-support identities consume that same closure. Reuse admission checks payloads through the manifest owner: entrypoints must be non-empty files, web requires existing local assets referenced by its entrypoint, and declared component support must resolve. Builders, admission probes, completed-flight reuse, latest-artifact selection and snapshot construction/selection share that check. Missing daemon support is repaired through its existing builder. Historical physical or retained self-contained snapshot components share payload health without requiring a current support binding; a rejected live canonical reference cannot fall back to historical reuse. These checks detect incomplete payloads, not arbitrary byte corruption.
- In current development source, managed daemon construction stages its immutable support artifact before compiling code. Support staging and code preparation receive the same captured workspace publication; code that consumes another dependency frame must restart the phase. Once that frame has been read coherently, later source edits or a newer shared publication do not invalidate the immutable support bytes. Support identity validation retains the captured source fingerprint through the component-artifacts owner rather than recomputing it from live source at the end of code compilation.
- Release/self-host packaging remains the existing per-target direct boundary. Each target builder materializes its target's complete self-contained component/support payload from settled component inputs; it does not consume or flatten a host-target managed snapshot. The resulting package must not depend on the checkout's `node_modules` or a system package manager.

In current development source, explicit artifact builds enter the component build owner's admission directly,
without a competing launcher-wide workspace publication. Requested components' preparation failures are
recorded in the producer's existing `runtimePublication` projection. Queue and lock-wait progress uses stderr,
including with JSON output. Native component builds commit a complete snapshot by composing
their built artifacts with the target's current unrequested components and return `snapshotId`.
Publication without activation preserves every stack's selected runtime, including the producer's
native pin. Composition validates component payload/support closure, execution target and
server flavor; component generations need not share a whole-checkout source fingerprint. Initialize a
native target with `--all` if it has no complete snapshot yet. Explicit foreign-target server-only builds
can publish a server subset without fabricating web or daemon artifacts. Service-specific consumers
validate the required subset; default admission still requires all three components. The consumer adopts the publication through
`stack runtime <consumer> select`, with no rebuild; other consumers use the same command. Selection
and publication do not restart services. `--activate-runtime` selects the requesting consumer
and the matching native producer snapshot.
Explicit `runtime activate` discovers stored artifacts under producer admission and delegates composition
to the same `publishBuiltRepositoryRuntimeSnapshot` owner; its launcher does not prepare source workspaces.

Explicit builds from every consumer and the source-development background publisher share one
cross-process publication flight per producer at `build_stack_artifacts.mjs`. Its `runtime/publication.lock`
covers only demand/sequence and success-record transactions, snapshot publication, retention, and selection.
Worker placement and admission wait outside the target-scoped lease. Existing demand records elect
one waiting placement owner; covered followers join without reserving a second worker.
Explicit-local builds use the same admission/control boundary before acquiring the target lease.
Only after actual admission do source capture, preparation, identity resolution and compilation
hold `runtime/publication.<platform>-<arch>.lock`. Different targets can build concurrently; each target
has one running build and one pending union, with covered waiters joining its success. Runtime activation
holds the shared admission through snapshot selection and retention; the separate `runtime/build.lock`
remains a short snapshot-commit transaction. Component pruning runs after snapshot publication and is
deferred while another target has live demand, protecting its unpublished staging/support bytes.
Demand captures the producer's persisted
`startedSeq` before dispatch. Admission increments it before starting a build; a waiter joins only a successful
flight with a greater sequence and coverage of every requested component. Missing or unreadable sequence
observations cannot reuse earlier success: fresh merged work can explicitly acknowledge the registered
request after it succeeds. Joining therefore does not depend on wall-clock ordering. Requests made
during one flight register their live demand before waiting; the next flight builds the union for its
target, so mixed daemon, server and all-component demand shares one trailing build. Dead request owners
are ignored and reclaimed. Success is retained per target and component with its flight sequence,
artifact identity and snapshot reference, so another target's success cannot erase satisfied demand.
Joining validates the exact completed artifact identities against retained snapshots; if no snapshot spans
that component vector, the canonical publisher composes those valid artifacts without recompiling.
Failed flights advance the start counter without replacing component success. Pending demand is
temporary coordination state and is removed when satisfied or abandoned.
JSON results distinguish `publicationFlight: "built"` from `"joined"`. Both paths select the requesting
consumer when activation was requested; merged demand never selects another caller's consumer. Background
publication advances only the producer. Source watcher
coalescing remains caller-side, keeps the latest sequence observation for each pending component, and
preserves it through child dispatch. Notifications received after dispatch remain dirty for trailing work.

In current development source, the producer's optional `runtimePlacement.build` enables remote preparation
and component compilation inside that same admitted flight in a dedicated dev-target workspace.
Local placement also captures source and executes the captured build owner, while keeping
artifact storage and source labels bound to the producer.
Build placement is resolved against the producer's target registry only. Controlled-runtime
consumer projections omit it; a consumer build entry is ignored with a warning naming the
producer config, even when its target is absent from the consumer registry.
It captures and uploads source before worker admission, reuses the install-freshness owner, and keeps worker
dependencies/dist separate from the moving mirror and live outputs. Source identity labels retain
the producer checkout origin so relocation alone does not change an input fingerprint. Component
and workspace-package identity readers share those origin labels. Runtime capture uses
the same one-pass/selective-trailing-read owner as QA workspace preparation. Transfer
fingerprints are derived from captured bytes, not from a before/after quiet-checkout
comparison. Producer edits after capture do not invalidate the build; existing demand
coalescing serves them in the next flight. Worker capture, requests, source trees,
and transfer archives live in the existing producer workspace partitioned by platform/architecture, so
concurrent targets cannot overwrite each other's prepared source or results. The worker source-transfer
owner reconciles captured authored inputs into the retained target checkout without rewriting unchanged
bytes; package outputs, compiler build info and receipts remain subject to their existing currentness
checks. The producer's request-local incoming archive does not replace target staging until actual
admission READY and the existing publication flight are acquired. Source-transfer PREPARE/ACK is not
admission READY and holds no runtime-build reservation. The shared workspace input-path
owner includes relative extended tsconfigs even when the referenced config is excluded as a
test-only root, so capture and package admission consume one complete config closure. Capture
and runtime-support fingerprints apply that owner's source-test exclusions during recursive
traversal too; whole source roots do not re-admit excluded tests. Explicit shipped resources
with test-like paths remain inputs. Development reload's benchmark, snapshot and scratch
exclusions are separate from artifact membership. Capture also includes manifest-declared
shipped inputs, binary resources and empty directories; its
symlink signatures compare link contents rather than unportable filesystem timestamps. Worker
source capture and fingerprints exclude generated plugin runtime, chunk and manifest artifacts,
including output-only parent directory membership. Authored `.happier-plugin/ui/hosted-web/**`
and declared shipped/native resources remain inputs. Reconciliation uses that same filtered
closure, removing stale authored sources while preserving worker-generated plugin outputs;
installed dependencies and build outputs outside that closure remain available. Capture rejection
names the differing components and the first twenty differing input paths. Worker bootstrap
uses the component owner's existing `qa-runtime` last-green policy. Component
and support manifests carry the explicit platform/architecture target; component identities also
separate targets (including web). Native AUTO is the single build-placement selector: candidates come
from the producer's command-execution pool, excluding its Metro host, and must meet the existing
runtime-build memory envelope and target/toolchain policy. Healthy busy workers remain eligible;
the build retains host-global waiting demand and queue age while re-evaluating alternatives on the
existing pressure cadence. Local fallback is allowed only when no healthy reachable capable worker
remains, not when workers are merely busy. A started build is never replayed after failure.
The requested
artifact target for an explicit consumer build follows each selected component's service placement:
server uses its server host, daemon uses its daemon host, and local components use the local host.
Separate targets publish separate snapshots in the same producer store. Split native service subsets do
not require or replace a complete producer snapshot. With placed services, explicit `--target` must match
at least one selected placement; it constrains matching components while the others retain their placement
targets. Without remote service placement it retains explicit cross-target build behavior. JSON exposes
`componentTargets` and, for split builds, `targetResults`. Mixed-target `--activate-runtime` fails before
building because a single selected snapshot cannot represent those service targets; select the existing
service subsets individually. The source-development publisher retains its explicit producer target.
Complete snapshot selection and retention are target-aware,
and a foreign-target publication does not replace the producer's native current pointer.
Server and web builds can use a worker of another operating system or architecture through their explicit target-aware builders.
Server support installs the exact installed Sharp version with npm's CPU/OS selection in an
isolated target dependency tree, while Bun and Prisma use their existing explicit targets.
Linux x64 workers can also build Linux ARM64 daemon support when npm, Python, make and the
`aarch64-linux-gnu` C/C++ toolchain are available. The CLI support owner acquires target runtime
packages in isolated npm CPU/OS-selected trees, cross-builds node-pty through node-gyp, and
runs FFmpeg's installer with its target architecture. Host build dependencies remain native.
The existing finalizer projects esbuild, Iroh and bare prebuilds as well as PTY/Sharp onto the target.
Other daemon cross-target pairs still require a matching native worker. The shared support-target
admission owner reports missing cross prerequisites before dispatch.
Finished payloads return through the shared runtime artifact closure
transfer, existing manifest validation and producer retention, then ordinary snapshot publication.
Transfer archives are staging files, not retained runtime artifacts. The producer retains its
captured `source.tar` until all selected transfer channels finish, then releases it; the worker removes its source archive
after extraction, including failed extraction. Downloaded artifact archives are released after
extraction, and the transfer owner cleans its local staging directory and remote archives on
success or failure. Remote cleanup failures remain visible without replacing the build failure.
Controlled snapshot uploads use the same transfer cleanup owner, including partial upload
failures before the remote import entry starts.
Worker dependencies, extracted source/build outputs and the producer's admitted artifact store
retain their existing lifecycle and retention owners.
In current 0.3 development, target-specific incremental worker checkouts share the worker CLI
home's package-manager cache and Iroh Cargo target directory. Separate target checkouts remain
necessary for concurrent target builds and their generated outputs. Linux runtime requests reuse
the custody scanner to reclaim other staging targets and historical temporary roots only after
24 hours without modification and with no live cwd, descriptor or mapping holder. Unknown process
visibility retains them. After export, the worker store uses canonical artifact count/reference
retention with the same additional live-holder protection. Yarn Classic v6 cache entries are
eligible for removal only when their remote resolution is absent from every protected mirror and
retained staging lockfile; this includes a configured 0.2 command mirror sharing the CLI home.
Unavailable lockfiles, unknown cache metadata and unknown process visibility preserve the cache.
Snapshot admission/publication remains producer-owned; no worker scheduler or second publication flight exists.
Unavailable or incompatible workers are excluded visibly before compilation dispatch. A busy worker's
actual host-global request stays queued, including service RSS and live class reservations, while
no-wait alternative attempts use that same admission owner. The original waiting request is released
only after an alternative has actual admission. No admission-check preflight or busy result authorizes
local compilation. A dispatched build failure is
authoritative and is not replayed locally. WSL uses the POSIX transport; native Windows remote build
placement is not supported. A controlled consumer normally selects the newest complete snapshot for its
observed execution target. The opt-in shared-development-database preset selects its remote host's server
subset; the controller's CLI/auth use a native daemon snapshot through the same authority, while
the daemon independently selects a snapshot for its placement host without replacing the server pin.
Start, select, activate and doctor share the launch-context component selector, which consumes
the existing placement-owned build target groups. A local daemon uses the controller's platform,
not the command-execution worker's. A QA daemon defaults to local because its Machine owns sessions,
resume and workspaces. Only an explicit consumer daemon pin can select one named host;
QA and command pools cannot override it. Fresh shared-db presets leave the daemon unpinned.
The existing supervisor transfers the per-service closure and connects a daemon-only worker through
its existing reverse forward. An unavailable pinned daemon host fails closed;
retained local server data still requires explicit handoff. The full split-host browser journey
remains unverified. Producing another architecture requires a compatible native/support
build, not relabeling bytes. Targetless predecessor snapshots remain host-local inputs rather
than proof of foreign-target compatibility.

Managed runtime support is component-owned, not a generic dependency-layer registry, and its references are a development/QA snapshot concern only. A server manifest may reference an immutable server-support artifact containing its generated Prisma/native closure; a daemon manifest may reference its immutable daemon-support artifact containing the CLI runtime dependencies, tools, and sidecars. The component builder computes and validates its own support identity. Snapshot validation follows those references, and retention follows the graph from retained snapshots through component artifacts to referenced support artifacts before deleting anything. Existing self-contained release/runtime artifacts remain readable until ordinary retention removes them. Release/self-host builders discover and embed their own complete target support closure directly.

Server support hashing and staging share the server-sidecar owner's membership rule. Workspace `dist/.happier-build-inputs.json` records are preparation evidence and are excluded from both: refreshing their timestamps or dependency fingerprints cannot invalidate unchanged runtime bytes. The workspace output owner defines the record filename; actual emitted code and native support still participate in support identity.

The managed server code artifact is independent of static web UI. Runtime launch supplies the selected web artifact through the existing `HAPPIER_SERVER_UI_DIR`/Stack UI-path owner. Borrowed Expo is a controlled-live development/QA UI provider; strict snapshot UI requires an explicit web artifact. Release and self-host builders may combine web and server into their own self-contained target payload, but managed server publication does not embed or regenerate web UI and release builders do not consume a managed snapshot.

## Dependency ownership

### Managed browser acquisition (0.3 development)

The browser source installs the protocol-pinned Chrome-for-Testing archive through
the CLI's `chromiumForTesting` projection and canonical pinned-archive installer.
It verifies the archive digest before streamed extraction and checks the installed
executable when resolving the source. System browsers are not substitutes for this
managed source.

Pinned Chromium executables exceed the generic extractor's per-file allowance.
This source reuses the extractor's existing total-expanded-byte budget for each
file; total expansion, entry/path admission, compression-ratio, and extraction
deadline policies remain enforced. This describes development source, not a
published-release guarantee.

On Linux, managed Chromium keeps its namespace/seccomp sandbox. If Chromium
reports `No usable sandbox!`, the launch owner checks AppArmor's
`apparmor_restrict_unprivileged_userns` setting and a real user-namespace probe.
When both establish the restriction, browser launch returns `sandbox_unavailable`
with the recovery action `happier browser sandbox install`.

Run that command on the machine that executes the browser. It reuses the managed
Chromium installer if needed, then performs one sudo action to install and load
an AppArmor `userns` profile attached to that installed executable's literal path.
In 0.3 development, agents can request the machine-scoped `browser.sandbox.install`
Action, subject to default human approval (waivable in Action settings). The daemon
uses this same installer with noninteractive sudo: Action approval does not grant
OS privileges. When sudo authorization is unavailable, the Action returns
`os_authorization_required`; run the local command with OS authorization and retry.
`--print` displays the profile for an already-installed browser without applying
it. This follows [Ubuntu's per-program user-namespace profile](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces).
The command does not restart services or change a global sysctl. A different
Happier home/executable path needs its own profile; run the command using the same
Happier home as the browser runtime. Retry browser open after installation.

### Optional CLI payloads (0.3 development)

Binary CLI packaging separates local semantic-memory inference, native voice
inference, and difftastic into the signed `happier-memory-runtime`,
`happier-voice-runtime`, and `happier-difftastic` components. The managed-installable
catalog exposes them for explicit installation and the real memory, voice, and diff
consumers acquire the CLI's exact version on first use. A validated
installed version can be reused offline; first acquisition still needs the release
service. Local memory startup does not hold daemon readiness while downloading,
and disabling memory prevents late activation. When `deleteOnDisable` is enabled,
it removes late-written model cache after pending initialization settles. The shared optional-runtime download is not
aborted on behalf of other callers.

The CLI host omits its direct Transformers and Sherpa dependencies and bundled
difftastic tool. Dependencies declared by trusted plugins and SDK packages retain
their own closure. FFmpeg remains in the base CLI because both voice decoding and
browser recording consume it; moving it would make the non-voice recording path
depend on voice installation policy. Voice worker entrypoints, SDK declarations,
public author docs, examples, API and capability references, licenses, and
executable dependency source maps are retained. The public SDK packages'
generated governance records (`api-declarations.md` and `api-surface.json`, never
committed; the npm tarball gets them from `prepack`) are neither copied nor declared
by the workspace bundler, driven by one list in
`PUBLIC_SDK_GENERATED_GOVERNANCE_RECORDS` in `packages/cli-common/src/workspaces/index.ts`. The binary
finalizer applies the same list plus the Plugin SDK's release-governance `scripts/`
subtree, atomically removing those entries from each packaged `package.json#files`
inventory first. Target projection
removes foreign ONNX and PTY prebuild directories, preserves the selected native
sidecars and source-built PTY fallbacks, and removes the opposite platform's exact
PTY terminal modules and native source directories. It also removes Windows-only
ps-list executables on POSIX. The finalizer removes only explicitly audited
nested dependency copies whose complete physical trees and permission bits match
an ancestor that Node will reach without an intervening package. Missing,
shadowed, or divergent copies remain; SDK declarations, licenses, and other
authoring files remain in the surviving tree. The audited 0.3 package closures
have no peer dependencies; a dependency update introducing peers requires a new
resolution audit before extending this list. The binary CLI's root `package-dist`
also drops its unused CJS build and declarations. Declaration maps and incremental
compiler metadata are removed from both the host and isolated components. Host dependency
declarations remain available for plugin authoring; isolated inference components omit their
unused declarations. Executable source maps remain available for Bun and Node diagnostics.
Runtime JSON, JS, licenses, and docs stay.

First-party acquisition reports phases and actual transferred bytes through the
existing system-task events. These samples are presentation data, not install
authority: unknown or malformed samples fall back to the normal task display.
This describes current development source, not a published-release guarantee.

The release verifier checks each optional component's signed checksum envelope and
uses the managed first-party extractor and catalog to validate entrypoints on every
target, including with `--skip-smoke`. Existing archive topology, metadata, and privacy
admission remains in force. Matching hosts also run `difft --version`, import the
Transformers Node entrypoint to construct an ONNX-backed tensor without downloading
a model, and import the Sherpa native entrypoint to verify an inference constructor.
`--skip-smoke` skips these optional executions; the matching base CLI still
has to attest both binary and Node-entrypoint versions, load the native command
catalog through `--help`, and run its isolated
MCP client/server, Sharp, and PTY runtime smoke. The smoke clears `NODE_PATH`, so
repository-hoisted dependencies cannot hide an incomplete archive, and it checks the
stable target-projection invariants, including absence of Transformers, Sherpa, and
the retired embedded voice archive/loader, the unused Claude Agent SDK, and
Windows-only PTY inputs.

Add dependencies to the package that imports them:

- If `packages/protocol` imports a library, add it to `packages/protocol/package.json#dependencies`.
- If `apps/cli` imports a library directly, add it to `apps/cli/package.json#dependencies`.
- Do not mirror protocol-only dependencies into `apps/cli` merely because CLI bundles protocol.

Bundled workspaces are copied into the host package and are not installed by npm as independent workspace packages. The bundler vendors their external runtime dependencies based on each bundled workspace's own `package.json`.

## Internal dependency closure

`bundleWorkspacePackagesWithRuntimeDependencies(...)` is the normal host bundling path. The lower-level `vendorBundledPackageRuntimeDependencies(...)` helper vendors external dependencies only and intentionally ignores `@happier-dev/*`; use it only when updating an already-published package tree independently is specifically required.

If a bundled workspace imports another internal workspace at runtime, the host package must also bundle that internal dependency. For example, a host that bundles `@happier-dev/cli-common` may also need `@happier-dev/agents` and `@happier-dev/protocol` if they are in the runtime import closure.

### One module instance for the plugin-shared runtime

The CLI's pkgroll build inlines its bundled internal workspaces into `package-dist`, except `PLUGIN_HOST_SHARED_RUNTIME_PACKAGES` (`apps/cli/scripts/pluginHostSharedRuntimePackages.mjs`: `@happier-dev/plugin-sdk` and `@happier-dev/protocol`). First-party plugin daemon bundles leave the same packages external, and the bundled-plugin generator reads the same list. Host and plugins therefore resolve one module instance of each from the shipped `node_modules` closure. An inlined host copy is a second instance: it doubles the protocol's module-level Zod schema graph (about 600 MB of daemon heap) and gives host and plugin code different schema identities.

Because these imports stay external, a `package-dist` whose workspace publication lacks an export it imports fails when the daemon links the module, not when pkgroll runs. The canonical build publishes the workspace closure before pkgroll and refuses a mixed closure (`build.mjs`).

The Bun-compiled binary still embeds its host copy. Bun cannot resolve a bare external specifier from its embedded `/$bunfs` root (reproduced with Bun 1.3.5), so these packages are not Bun compile externals. In the binary daemon, the host and the plugins still load separate instances.

## Adding a bundled internal workspace to a published package

When introducing a new `packages/<name>` that must ship with a published package:

1. Add it to the published package's `package.json#bundledDependencies`.
2. Add it to that package's `package.json#dependencies` with workspace version `"0.0.0"`.
3. Add it to the package's `scripts/bundleWorkspaceDeps.mjs` bundle list.
4. Update bundling and published-dependency tests.

For `packages/plugin-sdk`, source and integration validation must prove through the canonical governance and consumer fixtures that external consumers resolve only the supported public surface and do not require independently published internal workspaces. Do not create a local archive/install gate for feature completion; release automation owns the archive it publishes.

## Missing `dist` / invalid exports

Internal package `exports` point at `dist/**`. If `dist` is missing, consumers can fail with invalid-export errors.

Fix by building the workspace, for example:

```bash
yarn workspace @happier-dev/protocol build
```

Stack builds should fail fast or build missing internal workspace outputs through the stack build helpers.

## Bundling sanity checks

In 0.3 development, CLI password crypto imports sodium through
`apps/cli/src/auth/passwordSodium.cjs`. Its literal require selects the package's
public CommonJS export and keeps it visible through the ESM prebundle and Bun
compile. A module-URL `createRequire` call can instead resolve from Bun's embedded
filesystem after prebundling, where the physical payload's dependencies are not
reachable. The focused crypto bundle test runs the self-contained prebundle away
from repository dependencies and checks the canonical Argon2id/HKDF vector without
building the full CLI or requiring Bun in the unit-test environment. The installed sodium 0.7.16 ESM
wrapper references an absent sibling, so this boundary deliberately uses its
CommonJS export.

When touching bundling or dependencies, run the relevant source-level script and dependency-closure tests. For CLI changes, the check should prove that protocol dependencies are projected under the bundled protocol workspace path, not duplicated at the host root unless the host imports them directly. Feature QA does not produce or install a local release archive.
