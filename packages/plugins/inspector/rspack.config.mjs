import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as Repack from '@callstack/repack';

import { createStrictSafeGuardedRequireRspackPlugin } from '@happier-dev/plugin-sdk/experimental/ui/reactNativeRepackStrictSafety';

/**
 * NATIVE-PIPELINE (LEDGER DEC-6 follow-up, item 2): the inspector's iOS build
 * target for its ONE RN-authored surface (`src/ui/renderSurface.tsx`) — the
 * SAME source `vite.config.ts` builds for web (RN-DOGFOOD). This is the FIRST
 * real execution of the Re.Pack build pipeline in this repo; the container
 * name/expose path below is not a placeholder — it is derived to match
 * exactly what the native host loader
 * (`apps/ui/sources/components/plugins/reactNative/loader.ts`'s
 * `resolveDefaultFederatedModule` / `sanitizeFederatedIdentifier`) computes
 * for `federated.importModule(containerName, modulePath)` at runtime:
 * `sanitizeFederatedIdentifier('<pluginId>_<contributionId>')` →
 * `happier_inspector_inspector_app_native`, exposing `./renderSurface`.
 *
 * The plugin bundle is a Module Federation "remote" container — a pure
 * exposed-module bundle, never run as a standalone RN app entry — so this
 * config deliberately does NOT use `Repack.RepackPlugin` (which assembles a
 * full app main-entry bundle via `OutputPlugin`/`NativeEntryPlugin`). It uses
 * the lower-level pieces a federated remote needs directly:
 * `RepackTargetPlugin` (ScriptManager-compatible script output target) +
 * `ModuleFederationPlugin` (the container + expose).
 *
 * `filename`/`output.path` are pinned to the exact relative path
 * `defineReactNativeRepackBuildPreset` declares as `preset.output.entry`
 * (`react-native/<contributionId>/<platform>.bundle.js`) so
 * `buildUiArtifacts`'s `assertEntryEmitted` finds the emitted file.
 *
 * RN-HARDEN item 1: `createStrictSafeGuardedRequireRspackPlugin()` post-emit
 * patches Re.Pack's injected `guardedRequire` runtime module, which is
 * fatal under the strict-mode IIFE rspack emits for this container build
 * (`TypeError: Cannot assign to read-only property 'length'` — an upstream
 * `@callstack/repack` bug, verified against its own emitted template; see
 * `@happier-dev/plugin-sdk/experimental/ui/reactNativeRepackStrictSafety`'s
 * module doc). Applies to every reactNative-mode plugin's rspack build, not
 * just this one.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

const CONTRIBUTION_ID = 'inspector-app-native';
const CONTAINER_NAME = 'happier_inspector_inspector_app_native';

export default function config(env) {
  const { platform = 'ios', mode = 'production' } = env;

  return {
    mode,
    context: __dirname,
    entry: {},
    resolve: {
      ...Repack.getResolveOptions(platform),
    },
    output: {
      uniqueName: CONTAINER_NAME,
      path: join(__dirname, 'dist', 'happier-plugin-ui', 'react-native', CONTRIBUTION_ID),
      publicPath: 'noop:///',
      chunkFilename: '[name].chunk.bundle',
    },
    module: {
      rules: [
        ...Repack.getJsTransformRules({ codegen: { enabled: false } }),
        ...Repack.getAssetTransformRules(),
      ],
    },
    plugins: [
      new Repack.plugins.RepackTargetPlugin(),
      new Repack.plugins.ModuleFederationPlugin({
        name: CONTAINER_NAME,
        filename: `${platform}.bundle.js`,
        exposes: {
          './renderSurface': './src/ui/renderSurface.tsx',
        },
        // A federated REMOTE (this plugin container) consumes `react`/
        // `react-native` from the HOST app's already-loaded shared scope at
        // runtime — it must not bundle (and therefore must not compile) its
        // own copy. `eager: false` is the correct setting here (the inverse
        // of a HOST's `eager: true`); it also sidesteps having to compile
        // react-native's own internal Flow-syntax source files through this
        // checkout's installed `@callstack/repack`/flow-loader version at
        // all, which is otherwise a real, documented blocker below.
        shared: {
          // `import: false`: no fallback copy is bundled/compiled at all —
          // purely consumed from the host's shared scope at runtime. Without
          // this, MF still compiles a fallback module for the shared entry
          // even with `eager: false`, which re-triggers compiling
          // react-native's own internal source (see the comment above).
          react: { singleton: true, eager: false, import: false },
          'react-native': { singleton: true, eager: false, import: false },
        },
      }),
      createStrictSafeGuardedRequireRspackPlugin(),
    ],
  };
}
