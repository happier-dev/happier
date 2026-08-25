# Binary-Safe Runtime and Bundled Workspaces

Happier ships binary installers. First-party runtime paths must work on machines that do not have system `node`, `npm`, `npx`, `pnpm`, `yarn`, or `bunx`.

## Runtime contract

Do not introduce direct product-runtime calls to:

- `spawn('node', ...)`
- `npm`, `npx`, `pnpm`, `yarn`, `bunx`
- shell installers from UI/daemon/runtime code
- PATH-only agent/runtime detection as the sole source of truth

These are allowed only behind centralized managed runtime/tooling abstractions.

Before adding or changing an agent runtime, managed dependency, install, or update flow, classify it as one of:

- system-first agent CLI
- managed-first internal prerequisite
- managed package
- vendor install recipe
- managed JS-runtime dependent

Agent detection, install status, daemon validation, runtime spawning, and UI/managedDependencies must reuse the same source of truth. Agent CLIs should prefer user/system installs by default over Happier-managed installs unless an explicit setting says otherwise.

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

Publication has two explicit modes. Live source-dev refreshes keep each package directory mounted, publish complete files with `package.json` last, retain prior targets for in-flight module resolvers, and roll back already-published files if a later replacement fails. Artifact publication is selected by npm `prepack` or `--artifact`; it bypasses live freshness shortcuts and prunes retained targets so obsolete generations cannot enter a tarball. Health checks require every current source runtime file to match but deliberately allow extra retained targets in live trees.

All workspace/package publication that shares the CLI dist path uses the canonical cli-common lock implementation. Nested build processes inherit an owner-authenticated lease containing both the normalized path and a random owner token; a path alone never proves ownership and cannot bypass a successor process. Publication and the prepared consumer that reads the published graph are one locked transaction: reconciliation replaces the dependency tree entry by entry, so a compiler, API-surface, or prepack reader released early could resolve one module from the new generation and its import target from the previous one. The prepared consumer therefore runs inside the same held lock and receives that lock's lease, which is what lets a prepared script that republishes the graph itself — `prepack` — reenter instead of waiting for its own owner. Dependency builds preserve that lease but remove the parent package's staged-output override so one workspace cannot compile into another workspace's publication directory. If compiled cli-common helpers are unavailable during bootstrap, the repository sync script stages and vendors a complete package off-path before publishing it, and propagates failures without modifying the previous live package.

The stack pack sandbox copies the shared workspace scripts, materializes the complete internal build-tool workspace closure, and links the repository's installed root dependency tree for external build-tool resolution. Build-time workspaces remain separate from the package's declared runtime bundle closure, so tooling-only packages cannot leak into the tarball. The root dependency link is outside the packed package root and is removed with the sandbox.

`packages/support` is the library precedent for this pattern. `packages/plugin-sdk` follows the same doctrine: its packed tarball bundles the internal workspace closure needed by its public declarations and runtime helpers.

## Source, managed-runtime, and release boundaries

The same source tree serves four deliberately different policies:

The live/artifact workspace publication modes described above concern package source outputs and
their dependency closure; they are not managed runtime-snapshot publication.

- Source validation reads authored source and checked-in/generated compiler inputs. Typechecks, ordinary tests, lint, and searches do not publish CLI, server, UI, daemon, plugin, runtime-snapshot, or runtime-support artifacts.
- Source development starts from any valid last-green output when one exists, then refreshes changed source outputs in the background. For a checkout-derived repository producer, successful non-destructive server/daemon preparation requests publication through the canonical runtime publisher before the separately generation-fenced live activation; newer edits can therefore defer a service restart without discarding useful completed bytes. One publication runs at a time and later requests coalesce into one trailing identity recomputation. A full restart reconciliation compares web, server, and daemon identities. A failed publication leaves the current snapshot selected and source services unchanged, while its phase is written through existing runtime state.
- Managed named-stack publication builds only the requested runtime component(s), reuses unchanged component artifacts and owner-specific support artifacts, and commits a complete runtime snapshot whose component paths reference canonical producer payloads. A consumer selects that snapshot; it does not build or copy a second payload, and selection does not restart a running process.
- Release/self-host packaging remains the existing per-target direct boundary. Each target builder materializes its target's complete self-contained component/support payload from settled component inputs; it does not consume or flatten a host-target managed snapshot. The resulting package must not depend on the checkout's `node_modules` or a system package manager.

Managed runtime support is component-owned, not a generic dependency-layer registry, and its references are a development/QA snapshot concern only. A server manifest may reference an immutable server-support artifact containing its generated Prisma/native closure; a daemon manifest may reference its immutable daemon-support artifact containing the CLI runtime dependencies, tools, and sidecars. The component builder computes and validates its own support identity. Snapshot validation follows those references, and retention follows the graph from retained snapshots through component artifacts to referenced support artifacts before deleting anything. Existing self-contained release/runtime artifacts remain readable until ordinary retention removes them. Release/self-host builders discover and embed their own complete target support closure directly.

The managed server code artifact is independent of static web UI. Runtime launch supplies the selected web artifact through the existing `HAPPIER_SERVER_UI_DIR`/Stack UI-path owner. Borrowed Expo is a controlled-live development/QA UI provider; strict snapshot UI requires an explicit web artifact. Release and self-host builders may combine web and server into their own self-contained target payload, but managed server publication does not embed or regenerate web UI and release builders do not consume a managed snapshot.

## Dependency ownership

Add dependencies to the package that imports them:

- If `packages/protocol` imports a library, add it to `packages/protocol/package.json#dependencies`.
- If `apps/cli` imports a library directly, add it to `apps/cli/package.json#dependencies`.
- Do not mirror protocol-only dependencies into `apps/cli` merely because CLI bundles protocol.

Bundled workspaces are copied into the host package and are not installed by npm as independent workspace packages. The bundler vendors their external runtime dependencies based on each bundled workspace's own `package.json`.

## Internal dependency closure

`bundleWorkspacePackagesWithRuntimeDependencies(...)` is the normal host bundling path. The lower-level `vendorBundledPackageRuntimeDependencies(...)` helper vendors external dependencies only and intentionally ignores `@happier-dev/*`; use it only when updating an already-published package tree independently is specifically required.

If a bundled workspace imports another internal workspace at runtime, the host package must also bundle that internal dependency. For example, a host that bundles `@happier-dev/cli-common` may also need `@happier-dev/agents` and `@happier-dev/protocol` if they are in the runtime import closure.

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
