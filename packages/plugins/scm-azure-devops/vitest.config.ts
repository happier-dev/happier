import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import {
  createWorkspacePackageSourcesPlugin,
  type WorkspacePackageSpec,
} from '../../../scripts/testing/vitestWorkspacePackageResolution';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, '../../..');

/**
 * This source is checked against current workspace source of the SDK, the host protocol, the
 * public Plugin UI package and the shared Triage protocol — never against a previously built copy.
 *
 * Every value this source emits is admitted by a `@happier-dev/triage-protocol` schema, and those
 * schemas carry the bounds a list row must fit. Resolving through a built `dist/` lets a source
 * validate green against last week's bounds and then be rejected atomically at the real host
 * boundary, which is exactly the failure these tests exist to catch.
 */
const workspacePackages: readonly WorkspacePackageSpec[] = [
  {
    packageName: '@happier-dev/triage-sources',
    packageSourceRoot: resolve(repoRoot, 'packages/triage-sources/src'),
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

// The detail surface is a React Native surface, so its checks resolve the same React and
// react-native-web instances the UI package's own test project uses. Production externalization of
// those modules is unchanged.
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
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules/**', 'dist/**'],
  },
});
