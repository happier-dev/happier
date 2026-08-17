import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';
import {
  createWorkspacePackageSourcesPlugin,
  type WorkspacePackageSpec,
} from '../../scripts/testing/vitestWorkspacePackageResolution';

const workspacePackages: readonly WorkspacePackageSpec[] = [
  {
    packageName: '@happier-dev/plugin-sdk',
    packageSourceRoot: resolve('../../packages/plugin-sdk/src'),
  },
] as const;

const sharedExclude = [
  '**/.project/**',
  '**/.worktrees/**',
  '**/.dev/**',
  '**/output/**',
  '**/node_modules/**',
  '**/dist/**',
  ...resolveVitestFeatureTestExcludeGlobs(),
];

/**
 * The React copy every module in a project must agree on.
 *
 * `react-test-renderer` and `react-dom` are CommonJS inside `node_modules`, so
 * Vite never rewrites their internal `require('react')`. Each therefore pins the
 * project to the React instance that sits next to it on disk, and mixing them in
 * one project produces a null hook dispatcher. That physical constraint — not a
 * preference — is why this package runs two projects out of one config.
 */
const packageLocalReactAliases = [
  { find: /^react$/u, replacement: resolve('node_modules/react/index.js') },
  { find: /^react\/jsx-runtime$/u, replacement: resolve('node_modules/react/jsx-runtime.js') },
  { find: /^react\/jsx-dev-runtime$/u, replacement: resolve('node_modules/react/jsx-dev-runtime.js') },
  { find: /^react-test-renderer$/u, replacement: resolve('node_modules/react-test-renderer/index.js') },
];

/**
 * React Native Web is the real RNW runtime this monorepo ships to browsers
 * (`apps/ui`), so a `react-native` import in a presentation module resolves to
 * the same implementation a web build would use.
 *
 * This mount is SUPPORTING EVIDENCE ONLY. §7 layer 6 excludes jsdom, so it can
 * never close the EU-7 component gate — the packed-candidate browser QA and the
 * Maestro device lane own that. It exists so a component defect is caught in the
 * package's own RED/GREEN loop instead of only in a multi-minute packed lane.
 */
const reactNativeWebAliases = [
  { find: /^react$/u, replacement: resolve('../../apps/ui/node_modules/react/index.js') },
  { find: /^react\/jsx-runtime$/u, replacement: resolve('../../apps/ui/node_modules/react/jsx-runtime.js') },
  { find: /^react\/jsx-dev-runtime$/u, replacement: resolve('../../apps/ui/node_modules/react/jsx-dev-runtime.js') },
  { find: /^react-dom\/client$/u, replacement: resolve('../../apps/ui/node_modules/react-dom/client.js') },
  { find: /^react-dom$/u, replacement: resolve('../../apps/ui/node_modules/react-dom/index.js') },
  { find: /^react-native$/u, replacement: resolve('../../apps/ui/node_modules/react-native-web/dist/index.js') },
];

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: packageLocalReactAliases },
        plugins: [createWorkspacePackageSourcesPlugin(workspacePackages)],
        test: {
          name: 'package',
          globals: false,
          environment: 'node',
          setupFiles: ['./src/testSetup.ts'],
          env: { HAPPIER_FEATURE_POLICY_ENV: '' },
          include: ['src/**/*.{spec,test}.ts', 'src/**/*.{spec,test}.tsx'],
          exclude: [...sharedExclude, 'src/**/*.rnw.test.tsx'],
        },
      },
      {
        resolve: { alias: reactNativeWebAliases, dedupe: ['react', 'react-dom'] },
        plugins: [createWorkspacePackageSourcesPlugin(workspacePackages)],
        test: {
          name: 'rnw',
          globals: false,
          environment: 'jsdom',
          env: { HAPPIER_FEATURE_POLICY_ENV: '' },
          setupFiles: ['./src/rnwTestSetup.ts'],
          include: ['src/**/*.rnw.test.tsx'],
          exclude: sharedExclude,
        },
      },
    ],
  },
});
