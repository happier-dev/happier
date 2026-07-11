import { defineConfig } from 'vite';
import {
  createReactNativeWebVitePlugins,
  defineReactNativeWebViteBuildPreset,
} from '@happier-dev/plugin-sdk/ui/reactNativeWebBuild';

/**
 * RN-DOGFOOD: the inspector's web build target for its ONE RN-authored
 * surface (`src/ui/renderSurface.tsx`) — LEDGER DEC-6's "ship one
 * sourceEntry, get all platforms" story. Run with `vite build` (or via this
 * repo's `happier-plugin-build-ui` executor) to produce the
 * `dist/happier-plugin-ui/react-native-web/inspector-app-native/entry.mjs`
 * artifact referenced by `manifest.ts`'s `INSPECTOR_NATIVE_BUNDLE` contribution
 * (today wired for the `platform: 'web'` dev-hot-reload channel — see that
 * file's module doc for the contribution-declaration platform-multiplicity
 * caveat found during this lane).
 *
 * Native (ios/android) build status: `defineReactNativeRepackBuildPreset`
 * against this SAME `src/ui/renderSurface.tsx` source would produce the
 * Re.Pack artifact for native — proving the "one source, two build targets"
 * contract at the source level — but this repo has no Re.Pack/rspack build
 * pipeline wired up anywhere yet (Re.Pack is a apps/ui CLIENT-side dependency
 * only, for consuming already-built federation bundles via `ScriptManager`;
 * there is no `repack.config.mjs`/build script in this repo that produces
 * one). Standing up that pipeline is out of this lane's scope — tracked as a
 * residual, not silently assumed done.
 */
export default defineConfig(() => {
  const preset = defineReactNativeWebViteBuildPreset({
    contributionId: 'inspector-app-native',
    sourceEntry: 'ui/renderSurface.tsx',
    viteVersion: '7.3.1',
    hostUiApiVersion: '1.0.0',
    compatibility: { reactVersion: '19.2.0', reactNativeVersion: '0.83.4' },
  });

  return {
    plugins: [...createReactNativeWebVitePlugins()],
    resolve: {
      alias: preset.vite.resolve.alias.map((entry) => ({ find: entry.find, replacement: entry.replacement })),
    },
    build: {
      outDir: preset.output.root,
      minify: false,
      sourcemap: false,
      lib: {
        entry: 'src/' + preset.sourceEntry,
        formats: ['es'],
        fileName: () => 'entry.mjs',
      },
    },
  };
});
