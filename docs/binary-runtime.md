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

Managed-machine bootstrap in 0.3 development uses that same payload installer
and `remote.ssh.bootstrapMachine.v1` task recipe for SSH and native transports.
Native transport supplies admitted guest exec and binary file delivery only;
the host retains the resource identity, task lifetime, prompts and normal v3
Home enrollment. Native enrollment requires only buffered exec: normal finite
`auth request` retains claim secrets in protected guest pending state, the task
obtains approval, then `auth wait` registers the same guest. Live output observers
are optional and apply only to the selected guest process, not prerequisite
inspection processes. Provider-reported SSH key
evidence must match a fresh scan but cannot approve replacing saved host trust.

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

## Native computer driver (0.3 development source)

`apps/cli/src/packagedRuntime/installables/sourceAdapters/computerCuaDriver.ts` owns
native driver 0.31.0 acquisition, checksum/version validation and executable resolution.
`daemon/computer/driver/nativeTransport.ts` launches that installed absolute executable
directly in embedded MCP mode; no system Node, package manager or second launcher is involved.
X11 display/authentication/session variables are forwarded only on Linux, not macOS.
The same driver validates window/primary-desktop PNG dimensions and retained capture
geometry. Its viewer process cannot evict the model process's one-shot action binding.
Unknown input completion quarantines the source without replay. Explicit target
reselection waits for actual exit of the old native process before replacing
the source; the replacement needs a fresh capture before input. Requesting
process termination alone is not retirement proof.
Archive availability is not source or permission readiness; Windows/Wayland remain
unsupported, and the portable primary desktop is not a per-monitor identity catalog.
See [Computer target consent](actions.md#computer-target-consent-03-development-source)
for the current source, approval, independent native grants and confidential-entry limits.

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

In 0.3 development, `apps/stack/scripts/provision/.bun-version` is the single
Bun build/provisioning version owner. CI setup reads that file; managed Lima
readiness and streamed Lima/WSL provisioning consume the same value. Downloaded
Ubuntu provisioning needs the companion file from the script's same source ref,
or an explicit `HAPPIER_PROVISION_BUN_VERSION` override. Component builders still
resolve the selected executable and record its actual version in build identity;
this pin is not a managed Agent runtime or a change to installed product state.

Private workspace packages such as `packages/protocol`, `packages/agents`, `packages/cli-common`, and `packages/release-runtime` are not published independently, but they must ship inside published npm packages that import them at runtime.

Published hosts and bundled libraries currently include:

- `apps/cli`
- `apps/stack`
- `packages/relay-server`
- `packages/support`
- `packages/plugin-sdk`

Their `prepack` scripts run `scripts/bundleWorkspaceDeps.mjs`, which delegates to `bundleWorkspacePackagesWithRuntimeDependencies(...)`. That canonical publisher stages each workspace together with its external runtime dependency tree and publishes the internal dependency closure in dependency-first order.

Current 0.3 workspace bundling preserves runtime package-local `imports` declarations and their conditional order, alongside `exports`. Compiled bundled copies omit the development-only `happier-source` condition at every level of both maps, so source-enabled callers still resolve their complete compiled runtime. Authored source tools continue selecting workspace roots through the canonical source resolver. The existing workspace copier and bootstrap sync include exact retained relative import targets outside `dist`; external package targets still use the package's declared dependency closure. Live bundle health checks compare the retained import map and target files, and Stack bundle freshness observes package-root targets so changing only an imported runtime helper requires a refresh.

Publication has two explicit modes. Live source-dev refreshes keep each physical consumer package directory mounted, publish complete files with `package.json` last, retain prior targets for in-flight module resolvers, and roll back already-published files if a later replacement fails. A consumer workspace symlink or junction is replaced with a private directory rather than publishing through it into producer inputs; failed publication restores the link. Artifact publication is selected by npm `prepack` or `--artifact` and prunes retained targets so obsolete generations cannot enter a tarball. Both modes use the package build owner's content record to admit current `dist` outputs, including source additions and deletions, build inputs, compiler identity, and declared output bytes. Health checks require every current source runtime file to match but deliberately allow extra retained targets in live trees.

Public npm/SDK publication retains the workspace package-build owner, dependency
graph admission, captured package inputs, compiler state, currentness records and
publication locks. Strict packing/publishing still requires checked declarations
and valid runtime outputs. The public CLI package keeps CommonJS/ESM exports with
matching declarations; pkgroll remains an npm-publication tool, not a prerequisite
for native executables or source QA.

Remaining workspace dist consumers share build-mode selection and compiler
arguments through `packages/cli-common/workspaceChildBuildEnv.mjs`, including the
generic package emitter and cli-common's atomic compiler. `source-dev` and
`qa-runtime` use incremental unchecked emission; ordinary builds default to
strict, and public packing/publishing forces semantic checks before replacing
last-green output. This policy concerns package outputs, not native source
construction or the public no-emit typecheck.

In current 0.3 development, the explicit `happier-source` condition resolves
first-party source. Native CLI construction and retained source QA share the entry
authority in `packages/cli-common/sourceRuntimeEntries.mjs`: CLI exports/imports,
bundled plugin daemon entries and declared Agent runner leaves join one esbuild
graph. Native code construction rejects first-party dist/generated runtime inputs.
Bun compiles a launcher that loads the emitted physical ESM graph from its own
payload. It does not run pkgroll, the public declaration compiler, or a prior
CLI dist build.

Native server construction resolves `main.light.ts`, `main.ts`, and the packaged
migration entry through that same source export owner. Bun bundles the authored
graph directly, including the Iroh JavaScript loader; binary construction and
support discovery do not prepare workspace dist. Server support owns generated
Prisma clients, query and migration engines, Sharp assets, and the exact-target
Iroh addon with its package metadata. Sharp's binding loader still resolves the
addon beside the compiled executable so its libvips sidecar remains available.
Server typechecking and public npm/SDK declaration tasks remain separate.

Explicit web artifact construction and source QA share
`build_source_web_ui.mjs#prepareSourceWebUi`. It compiles authored plugin UI
through the SDK compiler and existing inventory generator into private inputs,
then supplies that inventory to Metro through
`HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY`. Expo exports browser code and assets
through the existing project-local staging and final-output owner. This source
path does not prepare workspace dist or public declarations; ordinary Expo and
public package preparation retain their own consumed inputs.

In current development source, source exports, web artifacts and release web
archives share `apps/stack/scripts/build/precompress_ui_web_assets.mjs` for
Brotli/gzip sidecars. It compresses JS, CSS, HTML, JSON, SVG, WASM and source maps
only when the encoded bytes are smaller. Export owners complete compression
before returning or publishing the directory. The server's `enableServeUi`
negotiates those sidecars for static assets, including exported HTML files,
varies on `Accept-Encoding`, and serves identity when no accepted sidecar exists.
Dynamic SPA entry responses retain the server readiness marker and identity
body used by Stack readiness checks. HTML retains `no-cache`;
asset cache rules and the existing absence of ETag/Last-Modified validators are
unchanged. Compression happens at export time, not in the request path.
The full managed-infrastructure `ui_gateway.mjs` currently serves files
independently without sidecar negotiation; that ingress does not yet consume
the server's precompressed serving policy.

Metro resolves workspace code from explicit authored package exports. Nested
`browser` or `react-native` source targets take precedence over the portable
`happier-source` target, preserving the package's platform implementation.
Resolution does not infer source paths from `dist` filenames or rewrite absolute
dist imports. Public default exports still select package outputs.

First-party JavaScript, JavaScript sidecars, plugin resources and UI package files
belong to code. Target-specific external/native dependencies, tools and Go payloads
remain support, with its publication metadata under `.project`. Support contains
`node_modules`, `tools` and `.project`; it no longer owns `scripts`.
Native construction does not require a prepared workspace-publication signature
or a copied CLI source generation. Source-resolution, syntax and bundler/process
failures abort construction; typechecking remains separate validation. Release
automation still owns self-contained target binaries, native assets and checked
public package declarations.

The bundled-plugin generator reads authored source for ordinary projection writes
and checks. `--mode check --scope projections` validates the semantic projections;
it does not compile a workspace dependency graph or prepare installed plugin runtime
bytes. Ordinary writes publish the source-owned projection set through that same
writer. There is no generator completion record, private compiler orchestrator or
prepared Agent-facts child protocol.

Repository source tools run with the source condition and shared registration leaf:

```sh
./apps/stack/bin/hstack-exec -- node --conditions=happier-source --import ./packages/cli-common/registerSourceRuntime.mjs apps/cli/scripts/build-owned/generateBundledPluginEntries.ts --mode check --scope projections
```

The registration leaf loads the TypeScript adapter and registers the canonical
workspace source resolver before the tool entry is linked. Public/npm preparation
explicitly requests `--package-artifacts` when installed plugin manifests and
runtime bytes must be materialized. Its workspace compilation and strict declaration
checks remain owned by `buildSharedDeps.mjs` and the package-build owner, not by the
projection generator.

All workspace/package publication that shares the CLI dist path uses the canonical cli-common lock implementation. Development waiters continue while an authenticated owner's heartbeat is fresh, even beyond the elapsed contention budget; the existing staleness policy governs owner recovery, while unknown or unreadable owners still have a bounded wait. Nested build processes inherit an owner-authenticated lease containing both the normalized path and a random owner token; a path alone never proves ownership and cannot bypass a successor process. Publication and the prepared consumer that reads the published graph are one locked transaction: reconciliation replaces the dependency tree entry by entry, so a compiler, API-surface, or prepack reader released early could resolve one module from the new generation and its import target from the previous one. The prepared consumer therefore runs inside the same held lock and receives that lock's lease, which is what lets a prepared script that republishes the graph itself — `prepack` — reenter instead of waiting for its own owner. Dependency builds preserve that lease but remove the parent package's staged-output override so one workspace cannot compile into another workspace's publication directory. If compiled cli-common helpers are unavailable during bootstrap, the repository sync script stages and vendors a complete package off-path before publishing it, and propagates failures without modifying the previous live package.


Package admission and staged compiler publication validate all exported runtime
entrypoints in one local-import traversal. Shared modules are read once per
validation, rather than once per export. Each admission and retry starts a fresh
traversal so missing imports, changed output and recovery remain observable;
visited state also terminates cycles without an arbitrary graph-size cutoff.

The stack pack sandbox copies the shared workspace scripts, materializes the complete internal build-tool workspace closure, and links the repository's installed root dependency tree for external build-tool resolution. Build-time workspaces remain separate from the package's declared runtime bundle closure, so tooling-only packages cannot leak into the tarball. The root dependency link is outside the packed package root and is removed with the sandbox.

`packages/support` is the library precedent for this pattern. `packages/plugin-sdk` follows the same doctrine: its packed tarball bundles the internal workspace closure needed by its public declarations and runtime helpers.

## Source, managed-runtime, and release boundaries

The same source tree serves four deliberately different policies:

The live/artifact workspace publication modes described above concern package source outputs and
their dependency closure; they are not managed runtime-snapshot publication.

In current 0.3 development, Stack daemon commands execute the launch command
admitted by the runtime snapshot, including profile reconciliation before startup.
A snapshot's separate Node entrypoint remains available for bundle-closure inspection
and provenance; it does not replace an admitted native launcher. Source launches
without an explicit command still use the managed JavaScript runtime.
Explicit-runtime Stack start, daemon lifecycle and CLI commands consume their
admitted snapshot without first preparing the moving source workspace. Source
commands retain the existing workspace preflight.

Controlled daemon-only workers consume their forwarded Home through the same
server-connection owner as source development: `--no-server --server-url=<url>`
does not resolve, start, adopt, or probe a local server database. Runtime admission
still requires the worker's daemon artifact; it does not require a server component
that runs on another host.
The controlled worker retains foreground custody after detached daemon startup,
including adopting its own already-running daemon through the existing lifecycle
owner. It records loaded runtime identity without forcing a healthy matching daemon
to restart, and the existing signal/shutdown path releases that custody.

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
- Source development starts from any valid last-green output when one exists, then refreshes changed source outputs through the existing service reload owners. Source startup, reloads, UI preparation and remote readiness do not request native runtime publication. Explicit artifact/build commands own that separate path; publication and selected/loaded runtime identities remain unchanged by source reloads.
- Managed named-stack publication probes the existing component source/toolchain identities and artifact manifests before bundled-plugin preparation. When every selected web/daemon artifact matches, bundled-plugin preparation is skipped. A web or daemon miss uses the canonical selected preparation closure and then recomputes identities after generated-input writes. Publication builds only the requested runtime component(s), reuses unchanged component artifacts and owner-specific support artifacts, and commits a complete runtime snapshot whose component paths reference canonical producer payloads. A consumer selects that snapshot; it does not build or copy a second payload, and selection does not restart a running process.
  Daemon-only preparation retains plugin-owned UI artifacts distributed with daemon code, but does not generate the UI application's app-preseed registry. The web consumer owns that registry; combined web/daemon preparation still generates it once.
  Web identity includes the projection producers and their build inputs. The bundled-plugin generator owns its authored-source closure, including esbuild-resolved transitive imports; web identity consumes that closure, while daemon code resolves its source entries through the shared source runtime owner. Reuse admission checks payloads through the manifest owner: entrypoints must be non-empty files, web requires existing local assets referenced by its entrypoint, and declared component support must resolve. Builders, admission probes, latest-artifact selection and snapshot construction/selection share that check. Missing daemon support is repaired through its existing builder. Historical physical or retained self-contained snapshot components share payload health without requiring a current support binding; a rejected live canonical reference cannot fall back to historical reuse. These checks detect incomplete payloads, not arbitrary byte corruption.
- In current development source, daemon code is bundled directly from source.
  Its independently reusable support artifact contains target-specific external
  runtime packages, tools and Go payloads, not a copied first-party JavaScript
  dependency frame. JavaScript sidecars and plugin resources/UI package files stay
  with code. Component manifests bind code to the admitted support reference.
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

Explicit built-runtime requests build only their requested components. Native AUTO
owns mirror synchronization, tooling readiness, target capability and worker memory
admission; compilation reads the selected worker's source checkout. There is no
source capture/upload, retained target build checkout, publication flight, merged
demand or persisted start sequence. Source development and default source QA do
not request native publication.

The producer's optional `runtimePlacement.build` remains build-placement policy.
Worker admission and compilation run outside the short producer publication lock.
A worker constructs a private final artifact store; a remote worker returns that
validated artifact closure through the existing transfer owner. Only final outputs
are staged/transferred. The producer imports them and commits the snapshot through
the existing short publication transaction. A dispatched build failure is reported,
not replayed locally.

Requested components' terminal outcomes remain in `runtimePublication`.
Publication without activation preserves every stack's selection. Explicit
activation/selection continues through the canonical snapshot owner; neither
publication nor selection restarts a running service.

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
Transfer archives are staging files, not retained runtime artifacts. Downloaded
final artifact archives and private stores are released after import. Remote
cleanup failures remain visible without replacing a build failure. Controlled
snapshot uploads retain the same cleanup owner, including partial upload failures.
The worker's source mirror, installed dependencies and package-manager cache remain
with their existing owners; native builds do not create another retained source
checkout. Worker disk admission and custody-safe reclamation remain at their
existing owner.

Unavailable or incompatible workers are excluded visibly before compilation dispatch. A busy worker's
actual host-global request stays queued, including service RSS and live class reservations, while
no-wait alternative attempts use that same admission owner. The original waiting request is released
only after an alternative has actual admission. No admission-check preflight or busy result authorizes
local compilation. A dispatched build failure is
authoritative and is not replayed locally. WSL uses the POSIX transport; native Windows remote build
placement is not supported. These native publication rules apply to the explicit built-runtime option,
not the default source QA path. In 0.3 development, new QA stacks use `source-snapshot`:
the existing supervisor flushes each executing host's mirror, then `run.mjs` directly bundles server
or CLI code with explicit first-party source exports and starts managed JS without watchers.
Bundling has no workspace dist/typecheck, publication flight, demand, archive-transfer or native
snapshot-selection prerequisite. Installed dependencies and target-native support remain host-owned.
Source CLI bundles also carry the public author SDK's JavaScript and declarations in a
private, bundle-owned package closure. The source-runtime producer uses the existing
compiler and workspace materializer with the source condition, without preparing workspace
`dist` or requiring semantic typechecking. Plugin authoring resolves that physical closure;
the CLI's source-runtime provenance and published SDK contracts are unchanged.
An explicit restart prepares current source. Stacks on the same host reuse a read-only
bundle when its source/tool cache fingerprint, captured esbuild bytes and compiler-reported
input versions still match current source.
The shared build-input inventory owns fingerprint membership; the bundle's emitted-code
hash owns runtime identity. Bundle directories are private allocations, not checkout
fingerprints. Edits during preparation do not reject successful output; a changed cache
fingerprint prevents reuse, and captured input digests also reject stale reuse after an
edit followed by Undo. This is a finite bundle of the bytes read, not an atomic checkout
snapshot. Concurrent preparation waits on the existing bundle lock before heavyweight
admission. Source bundles use the measured 4 GiB worker envelope;
web preparation/export keeps its separate validation envelope. A newer pending source start
supersedes only that stack's previous pending start. The bundle owner retains live/selected
bundles plus the newest, and reclaims unreferenced bundles when process visibility is available
(native Windows currently retains them). Emitted code remains unchanged between restarts. The existing
server also serves a one-shot source web export by default, prepared on its own host with a private
source-resolved plugin UI projection. Expo cache/state uses the stable Stack source root, separate
from each fresh frozen output. No Metro process or hot reload remains. `--ui=borrowed`
explicitly uses the configured moving Expo producer instead; its presence in the environment alone
does not select it. `--no-ui` keeps a source worker headless. Code preparation precedes the UI export,
and one-shot bundlers release their services rather than retain idle heaps in the Stack lifecycle owner.
`stack.runtime.json` projects each role's selected/loaded source-code identity, and loaded identity
is meaningful only with actual service/custody readiness. Daemon startup, including manual
post-auth startup, attests the retained bundle at the shared launch owner after that exact
entrypoint starts successfully. Merely adopting a healthy daemon does not infer a loaded
source identity. Controller CLI/auth uses its own retained
source bundle without replacing the remote role identities. Built QA uses `--runtime=built` and the
existing target-compatible selection instead. New `--qa`/`agent-qa-*` stacks request linux3, linux2 and linux1 through
their stack environment. The service-placement owner chooses the largest observed available-memory budget
after live reservations and persists one explicit daemon pin, because its Machine owns sessions, resume and
workspaces. Live Expo/browser/daemon RSS is already reflected in available memory. Add windows1-linux only
after its outer Windows C: disk is healthy; it is not a default candidate. Heavy validation remains on hosts
fitting its existing class envelopes, independently of this QA pool.
Existing stacks retain their placement until their owner explicitly changes it at the next restart.
QA and command pools cannot override that pin. Shared-db presets preserve the consumer's daemon choice.
Remote retirement accepts an unreadable runtime record only when its last write predates
the host's current boot; that prior process lifetime cannot survive the reboot. Unreadable
current-boot records still fail closed, and readable records retain the canonical process
ownership checks. Runtime identity probes report structured missing, empty or invalid
state errors with the exact state path and Stack recovery action.
The existing supervisor connects a daemon-only worker through its existing reverse forward.
Only built mode transfers the selected native per-service closure. An unavailable pinned daemon host fails closed;
retained local server data still requires explicit handoff. The full split-host browser journey
remains unverified. Producing another architecture requires a compatible native/support
build, not relabeling bytes. Targetless predecessor snapshots remain host-local inputs rather
than proof of foreign-target compatibility.

Before a fresh source invocation publishes its replacement launch, the daemon retirement owner
captures recorded PIDs and discovers unpublished starting daemons by exact stack, CLI home and
daemon process kind. Retirement verifies process incarnation through the shared ownership owner;
sessions and other stack homes are excluded. Attaching to an existing outer Stack owner does not
launch another generation.

QA host provisioning reuses managed JavaScript/Agent installers and the existing browser, power and
disk-retention owners. The service-placement owner selects the QA pool host with the greatest
observed unreserved memory for each browser lifetime, independently of the daemon pin. It does not
write placement or fall back to the controller. The browser lifecycle returns an owned
forwarded CDP endpoint to the controller. A lane-owned loopback reverse SOCKS forward uses the existing
SSH transport owner to reach the controller's server and borrowed Expo ingress. Chromium proxies
loopback traffic through that route, preserving the original origins and canonical Home address even
after authentication adopts the Home descriptor. Temporary-port URL rewriting is not used. The foreground browser handle owns cleanup; it does not register another runtime
or copy user Agent credentials. Linux service memory observes daemon/browser process trees alongside
server/Expo trees and supplies the existing admission reservation input.
Controlled artifact imports stage their closure on the destination Stack filesystem and remove that
owned staging directory on success or failure; system temp may be quota-limited tmpfs even when the
Stack store has space. Artifact admission and retained data are unchanged.
Dedicated QA-host browsers use `--no-sandbox` under the approved policy for Happier's own QA app.
The worker remains alive until its custody owner signals shutdown, including when payload stdin is closed.
Normal SIGINT/SIGTERM/SIGHUP shutdown requests `close` through custody's existing stdin control
channel and keeps the transport alive until `agent-browser close` and profile removal finish;
only then are the SOCKS/CDP forwards retired. Transport loss still uses remote execution's
process-group cancellation. A retained profile can be recovered on its original target through
`qa_browser.mjs --cleanup <session> <profile>`: the same worker cleanup owner closes that exact
session before removing its named QA profile beneath the target's temporary directory. A failed
close retains the profile and reports failure.

Codex's managed release recipe retains its native-file allowance and uses the plugin manifest schema's
512 MiB total expansion ceiling. The digest-verified `rust-v0.161.0` Linux package includes resources
beyond the installed executables and exceeds the former 384 MiB total. Digest verification, declared
runtime-member publication and the shared path/compression/extraction guards remain enforced.

Managed runtime support is component-owned, not a generic dependency-layer registry, and its references are a development/QA snapshot concern only. A server manifest may reference an immutable server-support artifact containing its generated Prisma/native closure; a daemon manifest may reference its immutable daemon-support artifact containing external/native runtime dependencies, tools and Go payloads; JavaScript sidecars and plugin resources/UI package files remain code-owned. The component builder computes and validates its own support identity. Snapshot validation follows those references, and retention follows the graph from retained snapshots through component artifacts to referenced support artifacts before deleting anything. Existing self-contained release/runtime artifacts remain readable until ordinary retention removes them. Release/self-host builders discover and embed their own complete target support closure directly.

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

For public npm publication, the CLI's pkgroll build inlines its bundled internal workspaces into `package-dist`, except `PLUGIN_HOST_SHARED_RUNTIME_PACKAGES` (`apps/cli/scripts/pluginHostSharedRuntimePackages.mjs`: `@happier-dev/plugin-sdk` and `@happier-dev/protocol`). First-party plugin daemon bundles leave the same packages external, and the bundled-plugin generator reads the same list. Host and plugins therefore resolve one module instance of each from the shipped `node_modules` closure. An inlined host copy is a second instance: it duplicates the Protocol schema graph actually admitted by that runtime and gives host and plugin code different schema identities. Owner-level schema deferral reduces unused construction; it does not make duplicate identities safe.

Because these imports stay external, a `package-dist` whose workspace publication lacks an export it imports fails when the daemon links the module, not when pkgroll runs. The canonical build publishes the workspace closure before pkgroll and refuses a mixed closure (`build.mjs`).

In current 0.3 development, native construction emits host, first-party plugin and
child entrypoints together with esbuild's shared ESM chunks. Bun compiles only the
launcher; it imports the physical `package-dist/index.mjs` beside its executable.
The host and plugins therefore use the same physical shared modules instead of
an embedded host copy plus physical plugin copies. The payload carries that ESM
graph and its target support; execution does not require system Node or a package
manager.

## Adding a bundled internal workspace to a published package

When introducing a new `packages/<name>` that must ship with a published package:

1. Add it to the published package's `package.json#bundledDependencies`.
2. Add it to that package's `package.json#dependencies` with workspace version `"0.0.0"`.
3. Add it to the package's `scripts/bundleWorkspaceDeps.mjs` bundle list.
4. Update bundling and published-dependency tests.

For `packages/plugin-sdk`, source and integration validation must prove through the canonical governance and consumer fixtures that external consumers resolve only the supported public surface and do not require independently published internal workspaces. Do not create a local archive/install gate for feature completion; release automation owns the archive it publishes.

## Missing `dist` / invalid exports

Ordinary published package exports include `dist/**` targets. If `dist` is missing,
public package consumers can fail with invalid-export errors. Native construction
and source QA explicitly select `happier-source` and resolve authored entrypoints
through the shared source owner instead.

Fix by building the workspace, for example:

```bash
yarn workspace @happier-dev/protocol build
```

Public package preparation must build missing internal workspace outputs through
the package-build owner. Native source construction must fail on missing authored
inputs rather than preparing or falling back to dist.

## Bundling sanity checks

In 0.3 development, CLI password crypto imports sodium through
`apps/cli/src/auth/passwordSodium.cjs`. Its literal require selects the package's
public CommonJS export in the source and esbuild graph. Externalizing that
require would let Rollup convert it to an ESM import, selecting sodium 0.7.16's
incomplete ESM export. The canonical CLI pkgroll preparation therefore inlines
this bundled dependency through the same mechanism used for bundled internals,
preserving its working CommonJS export inside the emitted ESM graph. Other
dependencies remain external; in particular, Ink's top-level-await modules
must retain async ESM loading. The canonical CLI binary code builder starts
the emitted `index.mjs` graph through its native launcher.
The physical ESM graph keeps module-URL `createRequire` calls relative to its
payload dependency tree. The focused crypto bundle test runs the self-contained
prebundle away
from repository dependencies and checks the canonical Argon2id/HKDF vector without
building the full CLI or requiring Bun in the unit-test environment. The installed sodium 0.7.16 ESM
wrapper references an absent sibling, so this boundary deliberately uses its
CommonJS export.

The daemon dependency owner test additionally runs canonical pkgroll preparation
and Bun's real resolver, then checks an async ESM dependency and the password KDF
from an isolated bundle without adjacent dependencies. It checks the bundle
failure boundary without building the full CLI or changing production compiler
limits.

When touching bundling or dependencies, run the relevant source-level script and dependency-closure tests. For CLI changes, the check should prove that protocol dependencies are projected under the bundled protocol workspace path, not duplicated at the host root unless the host imports them directly. Feature QA does not produce or install a local release archive.
