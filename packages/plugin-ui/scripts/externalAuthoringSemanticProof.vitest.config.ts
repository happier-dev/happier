import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
const consumerRoot = process.env.HAPPIER_PLUGIN_UI_EXTERNAL_AUTHORING_ROOT;
const externalTargetRoot = process.env.HAPPIER_PLUGIN_UI_EXTERNAL_TARGET_ROOT;
const externalContributorRoot = process.env.HAPPIER_PLUGIN_UI_EXTERNAL_CONTRIBUTOR_ROOT;

if (!consumerRoot) {
  throw new Error('HAPPIER_PLUGIN_UI_EXTERNAL_AUTHORING_ROOT is required.');
}
if (!externalTargetRoot) {
  throw new Error('HAPPIER_PLUGIN_UI_EXTERNAL_TARGET_ROOT is required.');
}
if (!externalContributorRoot) {
  throw new Error('HAPPIER_PLUGIN_UI_EXTERNAL_CONTRIBUTOR_ROOT is required.');
}

const installedSdkRoot = resolve(consumerRoot, 'node_modules/@happier-dev/plugin-sdk');
const installedPluginUiRoot = resolve(consumerRoot, 'node_modules/@happier-dev/plugin-ui');
const consumerNodeModulesRoot = resolve(consumerRoot, 'node_modules');
const requireFromPackedHost = createRequire(resolve(consumerRoot, 'package.json'));
const sdkTestingEntry = resolve(installedSdkRoot, 'dist/testing/index.js');
const sdkUiEntry = resolve(installedSdkRoot, 'dist/ui/index.js');
const pluginUiEntry = resolve(installedPluginUiRoot, 'dist/index.js');
const pluginUiAdvancedEntry = resolve(installedPluginUiRoot, 'dist/advanced/index.js');
const pluginUiPresentationEntry = resolve(installedPluginUiRoot, 'dist/presentation/index.js');
const pluginUiEnvironmentEntry = resolve(installedPluginUiRoot, 'dist/environment/index.js');
const pluginUiTestingEntry = resolve(installedPluginUiRoot, 'dist/testing/index.js');
const consumerReactEntry = resolve(consumerNodeModulesRoot, 'react/index.js');
const consumerReactJsxRuntimeEntry = resolve(consumerNodeModulesRoot, 'react/jsx-runtime.js');
const consumerReactJsxDevRuntimeEntry = resolve(consumerNodeModulesRoot, 'react/jsx-dev-runtime.js');
const consumerReactDomClientEntry = resolve(consumerNodeModulesRoot, 'react-dom/client.js');
const consumerReactDomEntry = resolve(consumerNodeModulesRoot, 'react-dom/index.js');
const consumerReactNativeWebEntry = resolve(consumerNodeModulesRoot, 'react-native-web/dist/index.js');
const packedExternalAuthoringSemanticSurfaceEntry = requireFromPackedHost.resolve(
  '@happier-fixture/external-authoring/semantic-surface',
);

export default defineConfig({
  // The external fixture compiles author TSX with `jsx: "react-jsx"`.
  // Keep the framework-owned semantic proof on that same public contract.
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: [
      { find: /^react$/u, replacement: consumerReactEntry },
      { find: /^react\/jsx-runtime$/u, replacement: consumerReactJsxRuntimeEntry },
      { find: /^react\/jsx-dev-runtime$/u, replacement: consumerReactJsxDevRuntimeEntry },
      { find: /^react-dom\/client$/u, replacement: consumerReactDomClientEntry },
      { find: /^react-dom$/u, replacement: consumerReactDomEntry },
      { find: /^react-native$/u, replacement: consumerReactNativeWebEntry },
      { find: /^@happier-dev\/plugin-sdk\/testing$/u, replacement: sdkTestingEntry },
      { find: /^@happier-dev\/plugin-sdk\/ui$/u, replacement: sdkUiEntry },
      { find: /^@happier-dev\/plugin-ui$/u, replacement: pluginUiEntry },
      { find: /^@happier-dev\/plugin-ui\/advanced$/u, replacement: pluginUiAdvancedEntry },
      { find: /^@happier-dev\/plugin-ui\/presentation$/u, replacement: pluginUiPresentationEntry },
      { find: /^@happier-dev\/plugin-ui\/environment$/u, replacement: pluginUiEnvironmentEntry },
      { find: /^@happier-dev\/plugin-ui\/testing$/u, replacement: pluginUiTestingEntry },
      {
        find: '@external-authoring/semantic-surface',
        replacement: packedExternalAuthoringSemanticSurfaceEntry,
      },
      {
        find: '@external-authoring/targeted-surface',
        replacement: resolve(externalTargetRoot, 'dist/surface.js'),
      },
      {
        find: '@external-authoring/targeted-contributor',
        replacement: resolve(externalContributorRoot, 'dist/index.js'),
      },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: {
    fs: {
      allow: [
        packageRoot,
        repositoryRoot,
        resolve(consumerRoot),
        resolve(externalTargetRoot),
        resolve(externalContributorRoot),
      ],
    },
  },
  test: {
    globals: false,
    environment: 'jsdom',
    pool: 'threads',
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    setupFiles: [resolve(packageRoot, 'src/rnwTestSetup.ts')],
    server: {
      deps: {
        // Public aliases become absolute installed paths before vite-node checks
        // externalization. Its package-name selector keeps those exact Plugin UI
        // modules in Vite transform scope, where the RNW alias owns react-native.
        // This host intentionally validates RN/RNW semantics across an installed
        // package graph. Keep the bounded test graph in Vite transform scope so
        // the exact host alias owns every React Native import, including nested
        // Plugin UI presentation modules.
        inline: true,
      },
    },
    include: [resolve(packageRoot, 'scripts/externalAuthoringSemanticProof.rnw.test.tsx')],
  },
});
