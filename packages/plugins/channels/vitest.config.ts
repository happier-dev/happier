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
    packageName: '@happier-dev/email-transports-protocol',
    packageSourceRoot: resolve(repoRoot, 'packages/email-transports-protocol/src'),
  },
  {
    packageName: '@happier-dev/channels-protocol',
    packageSourceRoot: resolve(repoRoot, 'packages/channels-protocol/src'),
  },
  {
    packageName: '@happier-dev/triage-protocol',
    packageSourceRoot: resolve(repoRoot, 'packages/triage-protocol/src'),
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
    packageName: '@happier-dev/agents',
    packageSourceRoot: resolve(repoRoot, 'packages/agents/src'),
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
  { find: /^react$/u, replacement: requireUiDependency.resolve('react') },
  { find: /^react\/jsx-runtime$/u, replacement: requireUiDependency.resolve('react/jsx-runtime') },
  { find: /^react\/jsx-dev-runtime$/u, replacement: requireUiDependency.resolve('react/jsx-dev-runtime') },
  { find: /^react-dom\/client$/u, replacement: requireUiDependency.resolve('react-dom/client') },
  { find: /^react-dom$/u, replacement: requireUiDependency.resolve('react-dom') },
  { find: /^react-native$/u, replacement: requireUiDependency.resolve('react-native-web/dist/index.js') },
  // Match plugin-ui's RNW harness: Vite does not choose Metro's .web SVG entry.
  { find: /^react-native-svg$/u, replacement: requireUiDependency.resolve('react-native-svg/lib/module/elements.web.js') },
];

export default defineConfig({
  // The source harness consumes sibling workspace setup and presentation owners.
  server: { fs: { allow: [repoRoot] } },
  resolve: { alias: reactNativeWebAliases, dedupe: ['react', 'react-dom'] },
  plugins: [createWorkspacePackageSourcesPlugin(workspacePackages)],
  test: {
    ...resolveVitestWorkers(),
    testTimeout: 15000,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    // React's dev/prod CJS build is chosen by NODE_ENV, and only the dev
    // build exports `act`. Pin it — and mark the act environment like the
    // plugin-ui rnw project — so an exported production NODE_ENV in a
    // contributor shell cannot fail every mounted-surface test at once.
    env: { HAPPIER_FEATURE_POLICY_ENV: '', NODE_ENV: 'test' },
    setupFiles: ['../../plugin-ui/src/rnwTestSetup.ts'],
    server: {
      deps: {
        // Source-level Channels checks must transform the current SDK and
        // Protocol leaves rather than a stale copied package dependency.
        inline: [
          /^@happier-dev\/plugin-sdk(?:\/|$)/,
          /^@happier-dev\/protocol(?:\/|$)/,
        ],
      },
    },
  },
});
