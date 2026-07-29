import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as Repack from '@callstack/repack';
import { createReactNativeRepackSharedModules } from '@happier-dev/plugin-sdk/ui/build';
import {
  INSPECTOR_REPACK_MODULE_IDENTITY,
  INSPECTOR_UI_RENDERER_ID,
  INSPECTOR_UI_SOURCE_ENTRY,
} from './uiBuildIdentity.mjs';

/**
 * NATIVE-PIPELINE (LEDGER DEC-6 follow-up, item 2): the inspector's iOS build
 * target for its ONE RN-authored surface (`src/ui/renderSurface.tsx`) — the
 * SAME source `vite.config.ts` builds for web (RN-DOGFOOD). This is the FIRST
 * real execution of the Re.Pack build pipeline in this repo. The exact
 * container/module/export identity is selected once in `uiBuildIdentity.mjs`,
 * emitted into the verified generated artifact graph, and consumed verbatim
 * by the native host loader. It is not inferred from plugin/contribution ids
 * or recovered from a loader default.
 *
 * The plugin bundle is a Module Federation "remote" container — a pure
 * exposed-module bundle, never run as a standalone RN app entry — so this
 * config deliberately does NOT use `Repack.RepackPlugin` (which assembles a
 * full app main-entry bundle via `OutputPlugin`/`NativeEntryPlugin`). It uses
 * the lower-level pieces a federated remote needs directly:
 * `RepackTargetPlugin` (ScriptManager-compatible script output target) +
 * `ModuleFederationPlugin` (the container + expose).
 *
 * `filename`/`output.path` are pinned to a platform-isolated work tree under
 * `node_modules/.cache/happier-plugin-ui/react-native/<contributionId>/<platform>`.
 * The host-owned UI builder verifies and stages each platform tree under the
 * canonical `dist/happier-plugin-ui/react-native/<contributionId>/<platform>`
 * artifact directory.
 *
 * The canonical UI build owner strict-safes Re.Pack's injected
 * `guardedRequire` after bundling and before digesting/publishing the final
 * tree. This author config only describes the actual federation container.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

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
      uniqueName: INSPECTOR_REPACK_MODULE_IDENTITY.containerName,
      path: join(
        __dirname,
        'node_modules',
        '.cache',
        'happier-plugin-ui',
        'react-native',
        INSPECTOR_UI_RENDERER_ID,
        platform,
      ),
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
        name: INSPECTOR_REPACK_MODULE_IDENTITY.containerName,
        filename: `${platform}.bundle.js`,
        exposes: {
          [INSPECTOR_REPACK_MODULE_IDENTITY.modulePath]: `./${INSPECTOR_UI_SOURCE_ENTRY}`,
        },
        // A federated REMOTE (this plugin container) consumes the exact React
        // runtime closure plus native singletons from the HOST app's
        // already-loaded shared scope at
        // runtime — it must not bundle (and therefore must not compile) its
        // own copy. `eager: false` is the correct setting here (the inverse
        // of a HOST's `eager: true`); it also sidesteps having to compile
        // react-native's own internal Flow-syntax source files through this
        // checkout's installed `@callstack/repack`/flow-loader version at
        // all, which is otherwise a real, documented blocker below.
        // `import: false`: no fallback copy is bundled/compiled at all —
        // purely consumed from the host's shared scope at runtime. The SDK
        // owns this exact map so automatic JSX imports cannot escape the same
        // React singleton contract as explicit `react` imports.
        shared: createReactNativeRepackSharedModules(),
      }),
    ],
  };
}
