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
    packageName: '@happier-dev/plugin-sdk',
    packageSourceRoot: resolve(repoRoot, 'packages/plugin-sdk/src'),
  },
  {
    packageName: '@happier-dev/plugin-ui',
    packageSourceRoot: resolve(repoRoot, 'packages/plugin-ui/src'),
  },
  {
    packageName: '@happier-dev/plugins-channel-discord',
    packageSourceRoot: resolve(repoRoot, 'packages/plugins/channel-discord/src'),
  },
  {
    packageName: '@happier-dev/plugins-channel-telegram',
    packageSourceRoot: resolve(repoRoot, 'packages/plugins/channel-telegram/src'),
  },
  {
    packageName: '@happier-dev/plugins-scm-github',
    packageSourceRoot: resolve(repoRoot, 'packages/plugins/scm-github/src'),
  },
];

// Mounted RNW contract tests must resolve the same React/RNW instances as the
// UI package's own test project. Production externalization stays unchanged.
const reactNativeWebAliases = [
  { find: /^react$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react/index.js') },
  { find: /^react\/jsx-runtime$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react/jsx-runtime.js') },
  { find: /^react\/jsx-dev-runtime$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react/jsx-dev-runtime.js') },
  { find: /^react-dom\/client$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react-dom/client.js') },
  { find: /^react-dom$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react-dom/index.js') },
  { find: /^react-native$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react-native-web/dist/index.js') },
];

export default defineConfig({
  resolve: { alias: reactNativeWebAliases, dedupe: ['react', 'react-dom'] },
  plugins: [createWorkspacePackageSourcesPlugin(workspacePackages)],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
  },
});
