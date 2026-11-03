import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { createWorkspaceHostSourceAlias } from '../../../scripts/testing/vitestWorkspacePackageResolution';
import { workspacePackageOptimizationExcludes, workspacePackageSourcesPlugin } from '../../../apps/cli/scripts/vitestWorkspacePackageResolution';

export default defineConfig({
  resolve: { alias: [createWorkspaceHostSourceAlias(resolve(__dirname, '../../..'), resolve(__dirname, '../../../apps/cli/src'))] },
  server: { fs: { allow: [resolve(__dirname, '../../..')] } },
  // Agent tests compose the real CLI host, including its workspace dependencies.
  optimizeDeps: { exclude: workspacePackageOptimizationExcludes },
  plugins: [workspacePackageSourcesPlugin],
  test: {
    ...resolveVitestWorkers(),
    environment: 'node',
    // The real host grant composition uses its source harness in the second lane.
    exclude: [...configDefaults.exclude, '**/interactions.mcpApprovalSubject.test.ts', '**/mcpToolPolicy.contract.test.ts'],
  },
});
