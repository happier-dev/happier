import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { createWorkspaceHostSourceAlias } from '../../../scripts/testing/vitestWorkspacePackageResolution';
import { workspacePackageOptimizationExcludes, workspacePackageSourcesPlugin } from '../../../apps/cli/scripts/vitestWorkspacePackageResolution';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { createTestHomeEnvironment } from '../../../scripts/testing/testHomeEnvironment.mjs';

export default defineConfig({
  // Compose the real CLI's complete workspace closure from current source.
  plugins: [workspacePackageSourcesPlugin],
  optimizeDeps: { exclude: workspacePackageOptimizationExcludes },
  resolve: { alias: [createWorkspaceHostSourceAlias(
    resolve(__dirname, '../../..'), resolve(__dirname, '../../../apps/cli/src'),
  )] },
  test: { ...resolveVitestWorkers(), environment: 'node',
    env: createTestHomeEnvironment().env,
    setupFiles: [resolve(__dirname, '../../../scripts/testing/vitestHomeSetup.mjs')],
    sequence: { setupFiles: 'list' },
    exclude: [
      ...configDefaults.exclude,
    ],
  },
});
