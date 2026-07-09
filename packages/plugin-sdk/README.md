# @happier-dev/plugin-sdk

The Happier plugin SDK is the public TypeScript contract for plugin manifests,
activation APIs, runtime context services, agent runtimes, hooks, actions, SCM,
reviews, MCP, local services, and descriptor-backed UI contributions.

## Public SDK release posture

Current posture: **prepublish hold**.

The V1 ABI subset is frozen by `SDK-FREEZE-GATE`, and first-party plugins are
required to use public SDK exports. This package is still marked `private: true`,
versioned `0.0.0`, and tagged with `happier.publicSdkRelease.posture:
prepublish_hold`. Do not remove that hold until the release gate changes the
package state and external publication is approved.

The current publication model is bundled-workspace packaging. `package.json`
declares `bundledDependencies` for `@happier-dev/agents` and
`@happier-dev/protocol`, and `prepack` runs `scripts/bundleWorkspaceDeps.mjs`.
The packed tarball must be self-sufficient without separately publishing those
internal workspaces. Bundling solves installation only; public API still comes
from the curated `@happier-dev/plugin-sdk` exports.

External publication requires explicit release approval. Do not treat the
workspace package as npm-ready solely because the freeze gate is green.

Support policy for the V1 public subset:

- Stable SDK exports are the subpaths listed in `package.json#exports`.
- Internal subpaths are not part of the public contract and must not appear in
  authoring docs, examples, or plugin templates.
- Additive SDK domains may ship behind experimental documentation before they
  become part of the stable V1 subset.
- Breaking changes to stable exports require a new major SDK release or an
  accepted pre-1.0 release-policy decision before external publication.
- First-party examples must compile or execute against public SDK exports only.

## Canonical authoring docs and examples

Authoring docs live at:

```text
apps/docs/content/docs/plugins/
```

## Install and build

In this repository, build the SDK with:

```bash
yarn workspace @happier-dev/plugin-sdk build
```

After external publication is approved, plugin authors install the package from
npm:

```bash
npm install @happier-dev/plugin-sdk
```

Basic activation example:

```ts
import type { PluginApi, PluginManifest } from '@happier-dev/plugin-sdk';

export const manifest: PluginManifest = {
  schemaVersion: 2,
  id: 'com.example.echo',
  version: '0.1.0',
  displayName: 'Echo',
  engines: { happier: '^0.0.0' },
  uses: ['actions'],
  entrypoints: {
    main: './dist/index.js',
    dev: './src/index.ts',
  },
  permissions: {
    required: [],
    optional: [],
  },
  contributes: {
    actions: [{
      id: 'echo',
      title: 'Echo',
      scopes: ['session'],
      surfaces: ['cli', 'mcp', 'agent'],
      placement: 'commandPalette',
      handler: {
        target: 'plugin',
        registrationId: 'echo',
      },
      dangerLevel: 'safe',
    }],
  },
};

export async function activate(host: PluginApi) {
  host.registerAction({
    id: 'echo',
    handler: async (request) => ({
      ok: true,
      data: { input: request.input },
    }),
  });
}
```

SDK-owned public TypeScript examples live at:

```text
packages/plugin-sdk/examples/public-authoring/
```

Those examples are the author-facing TypeScript reference for public SDK
imports. They include hosted-web descriptor security settings explicitly and
must compile against public `@happier-dev/plugin-sdk` exports only.

Plugin UI build authoring helpers under `@happier-dev/plugin-sdk/ui/*` are
developer-preview metadata helpers. They describe Vite hosted-web/embedded-web
outputs, Re.Pack React Native plain-JS outputs, canonical artifact paths, and
manifest entries. They do not execute builds, serve hosted-web assets, load
embedded web bundles, or load React Native bundles in production.

Current local runtime fixture packages live at:

```text
apps/cli/src/plugins/testkit/fixtures/authoring-examples/
```

Those fixtures are intentionally CLI/runtime regression examples. Public
release readiness still requires a scaffold/build/pack/install/trust smoke
flow, as tracked by `SDK-PRODUCT-READINESS-1`.

## Validation

Use the product-readiness validator for package/docs/example posture:

```bash
bash .project/plans/runtime-unification-v2/_validation/verify-sdk-product-readiness.sh .
```

Use the SDK freeze gate for ABI closure:

```bash
bash .project/plans/runtime-unification-v2/_validation/verify-sdk-freeze-gate.sh .
```

Publication validation should also pack the SDK tarball and compile out-of-repo
NodeNext and Vite consumers against the packed artifact, not workspace links.
