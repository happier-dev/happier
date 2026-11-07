import { createRequire } from 'node:module';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import {
  createWorkspacePackageSourcesPlugin,
  type WorkspacePackageSpec,
} from '../../../scripts/testing/vitestWorkspacePackageResolution';

const requireUiDependency = createRequire(new URL('../../../apps/ui/package.json', import.meta.url));

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, '../../..');

const workspacePackages: readonly WorkspacePackageSpec[] = [
  {
    packageName: '@happier-dev/cli-common',
    packageSourceRoot: resolve(repoRoot, 'packages/cli-common/src'),
  },
  {
    packageName: '@happier-dev/forge-ci',
    packageSourceRoot: resolve(repoRoot, 'packages/forge-ci/src'),
  },
  {
    packageName: '@happier-dev/channels-protocol',
    packageSourceRoot: resolve(repoRoot, 'packages/channels-protocol/src'),
  },
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

// The detail surface is a React Native surface, so its checks must resolve the same React
// and react-native-web instances the UI package's own test project uses. Production
// externalization of those modules is unchanged.
const reactNativeWebAliases = [
  { find: /^react$/u, replacement: requireUiDependency.resolve('react') },
  { find: /^react\/jsx-runtime$/u, replacement: requireUiDependency.resolve('react/jsx-runtime') },
  { find: /^react\/jsx-dev-runtime$/u, replacement: requireUiDependency.resolve('react/jsx-dev-runtime') },
  { find: /^react-dom\/client$/u, replacement: requireUiDependency.resolve('react-dom/client') },
  { find: /^react-dom$/u, replacement: requireUiDependency.resolve('react-dom') },
  { find: /^react-native$/u, replacement: requireUiDependency.resolve('react-native-web/dist/index.js') },
  // Metro selects SVG's web implementation by platform extension; Vite needs the same boundary.
  { find: /^react-native-svg$/u, replacement: requireUiDependency.resolve('react-native-svg/lib/module/elements.web.js') },
];

/** Source-only GitHub checks must not resolve stale copied SDK/Protocol packages. */
export default defineConfig({
  resolve: { alias: reactNativeWebAliases, dedupe: ['react', 'react-dom'] },
  plugins: [createWorkspacePackageSourcesPlugin(workspacePackages)],
  test: {
    ...resolveVitestWorkers(),
    testTimeout: 60000,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules/**', 'dist/**'],
    // React's dev/prod CJS build is chosen by NODE_ENV, and only the dev
    // build exports `act`. Pin it so an exported production NODE_ENV in a
    // contributor shell cannot fail every mounted-surface test at once.
    env: { HAPPIER_FEATURE_POLICY_ENV: '', NODE_ENV: 'test' },
  },
});
