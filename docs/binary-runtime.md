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

Publication has two explicit modes. Live source-dev refreshes keep each package directory mounted, publish complete files with `package.json` last, retain prior targets for in-flight module resolvers, and roll back already-published files if a later replacement fails. Artifact publication is selected by npm `prepack` or `--artifact` and prunes retained targets so obsolete generations cannot enter a tarball. Both modes use the package build owner's content record to admit current `dist` outputs, including source additions and deletions, build inputs, compiler identity, and declared output bytes. Health checks require every current source runtime file to match but deliberately allow extra retained targets in live trees.

In 0.3 development, the same package admission owner distinguishes compilation
from runtime materialization. A dependency's declarations (`.d.ts`, `.d.mts`,
`.d.cts`) and package resolution surface invalidate compilation, including
declarations reached through other internal dependencies. Implementation-only
dependency edits refresh bundled workspace copies and declared Plugin UI bundles
without entering dependent compilers. Full dependency bytes remain in the existing
build record: changed bytes run the package's prebuild projection checks and,
where declared, its `build:ui` output phase. Output refreshes retain the existing
package locks, staged publication, and moving-input rejection. The root preparation
adapter and source-dev synchronization publish refreshed plugin outputs through the
existing projection owner, just as they do newly compiled outputs.

Workspace preparation and bundled-plugin generation share one bounded convergence
owner. When inputs move during a successful package build, preparation retains the
last coherent output and takes one trailing pass through declaration-level package
admission. Completed unchanged packages are reused; only stale compilation or
runtime materialization runs again. Continued drift fails with a typed exhausted
result. Outside QA runtime publication, compiler and projection-command errors fail immediately, even when source
also changes; exhausted workspace failures and command failures retain their
classification across the generator's private child IPC and cannot trigger another
generator retry. The previous output is never certified as current after rejection.

In 0.3 development, runtime artifact publication explicitly selects
`qa-runtime` at the same workspace package-build owner. A failed TypeScript
compile may use that package's retained output only when its existing build
record, declared outputs, local import graph and dependency provenance remain
coherent. Missing or damaged output, process failures, runtime refresh failures
and input drift do not grant fallback. Drift retains the single trailing pass.
The existing record carries the compiler diagnostic and last-green build time;
component and snapshot manifests carry each stale package's record and output
identity. Artifact identities include the consumed stale outputs, including
daemon support, so a compiling replacement receives a different identity.
`stack info` and publication-flight results expose staleness. Ordinary builds
default to strict mode, and release publication forces strict compiler children.

All workspace/package publication that shares the CLI dist path uses the canonical cli-common lock implementation. Development waiters continue while an authenticated owner's heartbeat is fresh, even beyond the elapsed contention budget; the existing staleness policy governs owner recovery, while unknown or unreadable owners still have a bounded wait. Nested build processes inherit an owner-authenticated lease containing both the normalized path and a random owner token; a path alone never proves ownership and cannot bypass a successor process. Publication and the prepared consumer that reads the published graph are one locked transaction: reconciliation replaces the dependency tree entry by entry, so a compiler, API-surface, or prepack reader released early could resolve one module from the new generation and its import target from the previous one. The prepared consumer therefore runs inside the same held lock and receives that lock's lease, which is what lets a prepared script that republishes the graph itself — `prepack` — reenter instead of waiting for its own owner. Dependency builds preserve that lease but remove the parent package's staged-output override so one workspace cannot compile into another workspace's publication directory. If compiled cli-common helpers are unavailable during bootstrap, the repository sync script stages and vendors a complete package off-path before publishing it, and propagates failures without modifying the previous live package.

The bundled-plugin generator prepares dependencies before acquiring its publication lease. The private Agent-facts child prepares independently, then acquires its own short write lease; the parent does not hold a lease across the child. Manifest publication precedes selected-plugin preparation, and final projections retain the existing coherent output transaction. The shared dependency owner's signature is rechecked after lock admission and at the output commit. When a preparation or publication child fails and its consumed dependency fingerprint changed, the canonical request owner takes its existing single trailing preparation pass outside admission; package currentness retains unchanged outputs. Failures against unchanged inputs and failures on the trailing pass still propagate. Existing caller-owned leases remain authenticated and cannot be released by the child. Lock acquisition and release also retire expired or proven-dead priority-claim quarantine snapshots and the releasing owner's own snapshots; live or inconclusive claimants remain recoverable. Priority claims retain the existing continuous-waiter starvation protection. A waiter's result-reuse check runs after lock admission under the owner's heartbeat, so a slow currentness probe neither loses its handoff priority nor reads outputs during another publisher's replacement.

The stack pack sandbox copies the shared workspace scripts, materializes the complete internal build-tool workspace closure, and links the repository's installed root dependency tree for external build-tool resolution. Build-time workspaces remain separate from the package's declared runtime bundle closure, so tooling-only packages cannot leak into the tarball. The root dependency link is outside the packed package root and is removed with the sandbox.

`packages/support` is the library precedent for this pattern. `packages/plugin-sdk` follows the same doctrine: its packed tarball bundles the internal workspace closure needed by its public declarations and runtime helpers.

## Source, managed-runtime, and release boundaries

The same source tree serves four deliberately different policies:

The live/artifact workspace publication modes described above concern package source outputs and
their dependency closure; they are not managed runtime-snapshot publication.

- Source validation reads authored source and checked-in/generated compiler inputs. Typechecks, ordinary tests, lint, and searches do not publish CLI, server, UI, daemon, plugin, runtime-snapshot, or runtime-support artifacts.
- Source development starts from any valid last-green output when one exists, then refreshes changed source outputs in the background. For a checkout-derived repository producer, successful non-destructive server/daemon preparation requests publication through the canonical runtime publisher before the separately generation-fenced live activation; newer edits can therefore defer a service restart without discarding useful completed bytes. One publication runs at a time and later requests coalesce into one trailing identity recomputation. A full restart reconciliation compares web, server, and daemon identities. A failed publication leaves the current snapshot selected and source services unchanged, while its phase is written through existing runtime state.
- Managed named-stack publication probes the existing component source/toolchain identities and artifact manifests before bundled-plugin preparation. When every selected web/daemon artifact matches, bundled-plugin preparation is skipped. A web or daemon miss uses the canonical selected preparation closure and then recomputes identities after generated-input writes. Publication builds only the requested runtime component(s), reuses unchanged component artifacts and owner-specific support artifacts, and commits a complete runtime snapshot whose component paths reference canonical producer payloads. A consumer selects that snapshot; it does not build or copy a second payload, and selection does not restart a running process.
  Web identity includes the projection producers and their build inputs. The bundled-plugin generator owns its authored-source closure, including esbuild-resolved transitive imports; web and daemon-support identities consume that same closure. Reuse admission checks payloads through the manifest owner: entrypoints must be non-empty files, web requires existing local assets referenced by its entrypoint, and declared component support must resolve. Builders, admission probes, completed-flight reuse, latest-artifact selection and snapshot construction/selection share that check. Missing daemon support is repaired through its existing builder. Historical physical or retained self-contained snapshot components share payload health without requiring a current support binding; a rejected live canonical reference cannot fall back to historical reuse. These checks detect incomplete payloads, not arbitrary byte corruption.
- In current development source, managed daemon construction stages its immutable support artifact before compiling code. Support staging and code preparation receive the same captured workspace publication; code that consumes another dependency frame must restart the phase. Once that frame has been read coherently, later source edits or a newer shared publication do not invalidate the immutable support bytes. Support identity validation retains the captured source fingerprint through the component-artifacts owner rather than recomputing it from live source at the end of code compilation.
- Release/self-host packaging remains the existing per-target direct boundary. Each target builder materializes its target's complete self-contained component/support payload from settled component inputs; it does not consume or flatten a host-target managed snapshot. The resulting package must not depend on the checkout's `node_modules` or a system package manager.

In current development source, explicit artifact builds enter the component build owner's admission directly,
without a competing launcher-wide workspace publication. Requested components' preparation failures are
recorded in the producer's existing `runtimePublication` projection. Queue and lock-wait progress uses stderr,
including with JSON output; artifact-only success still awaits snapshot reconciliation and consumer activation.

Explicit builds from every consumer and the source-development background publisher share one
cross-process publication flight per producer at `build_stack_artifacts.mjs`. Its `runtime/publication.lock`
covers dependency preparation, identity resolution, artifact construction and snapshot publication.
Runtime activation also holds this admission through snapshot selection and retention; the separate
`runtime/build.lock` remains a short snapshot-commit transaction. Demand captures the producer's persisted
`startedSeq` before dispatch. Admission increments it before starting a build; a waiter joins only a successful
flight with a greater sequence and coverage of every requested component. Missing or unreadable sequence
observations require fresh work. Joining therefore does not depend on wall-clock ordering. Requests made
during one flight share a trailing flight when their component coverage matches. Failed flights advance
the start counter but never replace success. The success record contains only the flight sequence,
requested components, snapshot identity and artifact identities, not a durable queue.
JSON results distinguish `publicationFlight: "built"` from `"joined"`. Both paths select the requesting
consumer when activation was requested; background publication advances only the producer. Source watcher
coalescing remains caller-side, keeps the latest sequence observation for each pending component, and
preserves it through child dispatch. Notifications received after dispatch remain dirty for trailing work.

In current development source, the producer's optional `runtimePlacement.build` dispatches preparation
and component compilation inside that same admitted flight to a dedicated dev-target workspace.
It captures the flight's source before dispatch, reuses the install-freshness owner, and keeps worker
dependencies/dist separate from the moving mirror and live outputs. Source identity labels retain
the producer checkout origin so relocation alone does not change an input fingerprint. Component
and support manifests carry the explicit platform/architecture target; component identities also
separate targets (including web). The worker must match the producer target because native support
construction remains host-native. Finished payloads return through the shared runtime artifact closure
transfer, existing manifest validation and producer retention, then ordinary snapshot publication.
Snapshot admission/selection remains local; no worker scheduler or second publication flight exists.
Unavailable workers fall back visibly before compilation dispatch. A dispatched build failure is
authoritative and is not replayed locally. WSL uses the POSIX transport; native Windows remote build
placement is not supported. Producing a second architecture for a different consumer still requires
a target-native build plus consumer-target snapshot selection; it is not enabled by relabeling bytes.

Managed runtime support is component-owned, not a generic dependency-layer registry, and its references are a development/QA snapshot concern only. A server manifest may reference an immutable server-support artifact containing its generated Prisma/native closure; a daemon manifest may reference its immutable daemon-support artifact containing the CLI runtime dependencies, tools, and sidecars. The component builder computes and validates its own support identity. Snapshot validation follows those references, and retention follows the graph from retained snapshots through component artifacts to referenced support artifacts before deleting anything. Existing self-contained release/runtime artifacts remain readable until ordinary retention removes them. Release/self-host builders discover and embed their own complete target support closure directly.

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

When touching bundling or dependencies, run the relevant source-level script and dependency-closure tests. For CLI changes, the check should prove that protocol dependencies are projected under the bundled protocol workspace path, not duplicated at the host root unless the host imports them directly. Feature QA does not produce or install a local release archive.
