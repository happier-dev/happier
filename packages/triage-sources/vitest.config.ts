import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import {
  createWorkspacePackageSourcesPlugin,
  type WorkspacePackageSpec,
} from '../../scripts/testing/vitestWorkspacePackageResolution';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, '../..');

/**
 * Every contract this package reads is checked against current workspace
 * SOURCE, never a previously built copy. Its whole job is to consume the
 * Connected Accounts materialization seam and three published results
 * correctly, so a stale `dist` would let a schema change land green here and
 * fail in the product.
 */
const workspacePackages: readonly WorkspacePackageSpec[] = [
  {
    packageName: '@happier-dev/plugin-sdk',
    packageSourceRoot: resolve(repoRoot, 'packages/plugin-sdk/src'),
  },
  {
    packageName: '@happier-dev/plugin-ui',
    packageSourceRoot: resolve(repoRoot, 'packages/plugin-ui/src'),
  },
  {
    packageName: '@happier-dev/protocol',
    packageSourceRoot: resolve(repoRoot, 'packages/protocol/src'),
  },
  {
    packageName: '@happier-dev/triage-protocol',
    packageSourceRoot: resolve(repoRoot, 'packages/triage-protocol/src'),
  },
];

/**
 * The settings page is a React Native surface, so its mounted checks must
 * resolve the same React and react-native-web instances the UI package's own
 * test project uses. Production externalization of those modules is unchanged.
 */
const reactNativeWebAliases = [
  { find: /^react$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react/index.js') },
  { find: /^react\/jsx-runtime$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react/jsx-runtime.js') },
  { find: /^react\/jsx-dev-runtime$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react/jsx-dev-runtime.js') },
  { find: /^react-dom\/client$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react-dom/client.js') },
  { find: /^react-dom$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react-dom/index.js') },
  { find: /^react-native$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react-native-web/dist/index.js') },
];

export default defineConfig({
  root: packageRoot,
  resolve: { alias: reactNativeWebAliases, dedupe: ['react', 'react-dom'] },
  plugins: [createWorkspacePackageSourcesPlugin(workspacePackages)],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules/**', 'dist/**'],
  },
});
