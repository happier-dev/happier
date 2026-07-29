import { defineConfig } from 'vite';
import {
  createReactNativeWebVitePlugins,
  defineReactNativeWebViteBuildPreset,
} from '@happier-dev/plugin-sdk/ui/build';

/**
 * RN-DOGFOOD: the inspector's web build target for its ONE RN-authored
 * surface (`src/ui/renderSurface.tsx`) — LEDGER DEC-6's "ship one
 * sourceEntry, get all platforms" story. Run with `vite build` (or via this
 * repo's `happier-plugin-build-ui` executor) to produce the
 * `dist/ui/react-native-web/inspector-app-native/entry.mjs` work artifact.
 * The host-owned UI builder verifies and stages those bytes under the final
 * `dist/happier-plugin-ui` artifact root.
 *
 * The sibling Re.Pack target is declared in `happier-plugin-ui.config.mjs`
 * and configured by `rspack.config.mjs`; the canonical UI build runs both so
 * regenerating the artifact manifest cannot silently discard either target.
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
      outDir: 'node_modules/.cache/happier-plugin-ui/react-native-web/inspector-app-native',
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
