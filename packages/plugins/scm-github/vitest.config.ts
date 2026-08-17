import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import {
  createWorkspacePackageSourcesPlugin,
  type WorkspacePackageSpec,
} from '../../../scripts/testing/vitestWorkspacePackageResolution';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, '../../..');

const workspacePackages: readonly WorkspacePackageSpec[] = [
  {
    packageName: '@happier-dev/channels-protocol',
    packageSourceRoot: resolve(repoRoot, 'packages/channels-protocol/src'),
  },
  {
    packageName: '@happier-dev/scm-forge-adapter',
    packageSourceRoot: resolve(repoRoot, 'packages/scm-forge-adapter/src'),
  },
  {
    packageName: '@happier-dev/plugin-sdk',
    packageSourceRoot: resolve(repoRoot, 'packages/plugin-sdk/src'),
  },
  {
    packageName: '@happier-dev/protocol',
    packageSourceRoot: resolve(repoRoot, 'packages/protocol/src'),
  },
  {
    packageName: '@happier-dev/plugin-ui',
    packageSourceRoot: resolve(repoRoot, 'packages/plugin-ui/src'),
  },
  {
    packageName: '@happier-dev/triage-protocol',
    packageSourceRoot: resolve(repoRoot, 'packages/triage-protocol/src'),
  },
];

// The detail surface is a React Native surface, so its checks must resolve the same React
// and react-native-web instances the UI package's own test project uses. Production
// externalization of those modules is unchanged.
const reactNativeWebAliases = [
  { find: /^react$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react/index.js') },
  { find: /^react\/jsx-runtime$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react/jsx-runtime.js') },
  { find: /^react\/jsx-dev-runtime$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react/jsx-dev-runtime.js') },
  { find: /^react-dom\/client$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react-dom/client.js') },
  { find: /^react-dom$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react-dom/index.js') },
  { find: /^react-native$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react-native-web/dist/index.js') },
];

/** Source-only GitHub checks must not resolve stale copied SDK/Protocol packages. */
export default defineConfig({
  resolve: { alias: reactNativeWebAliases, dedupe: ['react', 'react-dom'] },
  plugins: [createWorkspacePackageSourcesPlugin(workspacePackages)],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules/**', 'dist/**'],
  },
});
