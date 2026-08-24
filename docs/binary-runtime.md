# Binary-Safe Runtime and Bundled Workspaces

Happier ships binary installers. First-party runtime paths must work on machines that do not have system `node`, `npm`, `npx`, `pnpm`, `yarn`, or `bunx`.

## Runtime contract

Do not introduce direct product-runtime calls to:

- `spawn('node', ...)`
- `npm`, `npx`, `pnpm`, `yarn`, `bunx`
- shell installers from UI/daemon/runtime code
- PATH-only provider detection as the sole source of truth

These are allowed only behind centralized managed runtime/tooling abstractions.

Before adding or changing a provider/runtime/install/update flow, classify it as one of:

- system-first backend CLI
- managed-first internal prerequisite
- managed package
- vendor install recipe
- managed JS-runtime dependent

Provider detection, install status, daemon validation, runtime spawning, and UI/installables must reuse the same source of truth. Backend CLIs should prefer user/system installs by default over Happier-managed installs unless an explicit setting says otherwise.

## Internal workspace packages

Private workspace packages such as `packages/protocol`, `packages/agents`, `packages/cli-common`, and `packages/release-runtime` are not published independently, but they must ship inside published npm packages that import them at runtime.

Published hosts currently include:

- `apps/cli`
- `apps/stack`
- `packages/relay-server`

Their `prepack` scripts run `scripts/bundleWorkspaceDeps.mjs` to copy bundled workspaces into the host package and vendor each bundled workspace's external runtime dependency tree under that workspace's bundled `node_modules`.

## Dependency ownership

Add dependencies to the package that imports them:

- If `packages/protocol` imports a library, add it to `packages/protocol/package.json#dependencies`.
- If `apps/cli` imports a library directly, add it to `apps/cli/package.json#dependencies`.
- Do not mirror protocol-only dependencies into `apps/cli` merely because CLI bundles protocol.

Bundled workspaces are copied into the host package and are not installed by npm as independent workspace packages. The bundler vendors their external runtime dependencies based on each bundled workspace's own `package.json`.

## Internal dependency closure

`vendorBundledPackageRuntimeDependencies(...)` vendors external dependencies only. It intentionally ignores `@happier-dev/*`.

If a bundled workspace imports another internal workspace at runtime, the host package must also bundle that internal dependency. For example, a host that bundles `@happier-dev/cli-common` may also need `@happier-dev/agents` and `@happier-dev/protocol` if they are in the runtime import closure.

## Adding a bundled internal workspace to CLI

When introducing a new `packages/<name>` that must ship with CLI:

1. Add it to `apps/cli/package.json#bundledDependencies`.
2. Add it to `apps/cli/package.json#dependencies` with workspace version `"0.0.0"`.
3. Add it to the `bundles` list in `apps/cli/scripts/bundleWorkspaceDeps.mjs`.
4. Update CLI bundling and published-dependency tests.

## Missing `dist` / invalid exports

Internal package `exports` point at `dist/**`. If `dist` is missing, consumers can fail with invalid-export errors.

Fix by building the workspace, for example:

```bash
yarn workspace @happier-dev/protocol build
```

Stack builds should fail fast or build missing internal workspace outputs through the stack build helpers.

## Bundling sanity checks

When touching bundling or dependencies, run the relevant source-level script and dependency-closure tests. For CLI changes, the check should prove that protocol dependencies are projected under the bundled protocol workspace path, not duplicated at the host root unless the host imports them directly. Feature QA does not produce or install a local release archive; release automation owns the archive it publishes.
