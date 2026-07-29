import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';
import {
  createWorkspacePackageSourcesPlugin,
  type WorkspacePackageSpec,
} from '../../scripts/testing/vitestWorkspacePackageResolution';

const workspacePackages: readonly WorkspacePackageSpec[] = [
  {
    packageName: '@happier-dev/protocol',
    packageSourceRoot: resolve('../../packages/protocol/src'),
  },
] as const;

export default defineConfig({
  resolve: {
    alias: [
      { find: /^react$/u, replacement: resolve('node_modules/react/index.js') },
      { find: /^react\/jsx-runtime$/u, replacement: resolve('node_modules/react/jsx-runtime.js') },
      { find: /^react\/jsx-dev-runtime$/u, replacement: resolve('node_modules/react/jsx-dev-runtime.js') },
      { find: /^react-test-renderer$/u, replacement: resolve('node_modules/react-test-renderer/index.js') },
    ],
  },
  test: {
    globals: false,
    environment: 'node',
    setupFiles: ['./src/testSetup.ts'],
    env: {
      HAPPIER_FEATURE_POLICY_ENV: '',
    },
    include: ['src/**/*.{spec,test}.ts', 'src/**/*.{spec,test}.tsx'],
    exclude: [
      '**/.project/**',
      '**/.worktrees/**',
      '**/.dev/**',
      '**/output/**',
      '**/node_modules/**',
      '**/dist/**',
      ...resolveVitestFeatureTestExcludeGlobs(),
    ],
  },
  plugins: [
    createWorkspacePackageSourcesPlugin(workspacePackages),
  ],
});
