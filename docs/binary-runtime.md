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

All workspace/package publication that shares the CLI dist path uses the canonical cli-common lock implementation. Nested build processes inherit an owner-authenticated lease containing both the normalized path and a random owner token; a path alone never proves ownership and cannot bypass a successor process. Dependency builds preserve that lease but remove the parent package's staged-output override so one workspace cannot compile into another workspace's publication directory. If compiled cli-common helpers are unavailable during bootstrap, the repository sync script stages and vendors a complete package off-path before publishing it, and propagates failures without modifying the previous live package.

The stack pack sandbox copies the shared workspace scripts, materializes the complete internal build-tool workspace closure, and links the repository's installed root dependency tree for external build-tool resolution. Build-time workspaces remain separate from the package's declared runtime bundle closure, so tooling-only packages cannot leak into the tarball. The root dependency link is outside the packed package root and is removed with the sandbox.

`packages/support` is the library precedent for this pattern. `packages/plugin-sdk` follows the same doctrine: its packed tarball bundles the internal workspace closure needed by its public declarations and runtime helpers.

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

For `packages/plugin-sdk`, the acceptance rule is stricter than an in-repo build: `npm pack` the SDK, install that tarball in an out-of-repo project, and compile consumers without separately publishing `@happier-dev/protocol`, `@happier-dev/agents`, or other internal workspaces.

## Missing `dist` / invalid exports

Internal package `exports` point at `dist/**`. If `dist` is missing, consumers can fail with invalid-export errors.

Fix by building the workspace, for example:

```bash
yarn workspace @happier-dev/protocol build
```

Stack builds should fail fast or build missing internal workspace outputs through the stack build helpers.

## Packaging sanity checks

When touching bundling/dependencies, run the relevant script tests and validate tarball contents. For CLI changes, the check should prove that protocol dependencies appear under the bundled protocol workspace path, not duplicated at the host root unless the host imports them directly.
