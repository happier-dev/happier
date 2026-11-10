import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { createWorkspaceHostSourceAlias, createWorkspacePackageSourcesPlugin, readHostWorkspacePackageSpecs } from '../../../scripts/testing/vitestWorkspacePackageResolution';

const workspacePackages = readHostWorkspacePackageSpecs(resolve(__dirname, '../../..'), resolve(__dirname, '../../../apps/cli'), [
  { packageName: '@happier-dev/plugins-codex', packageSourceRoot: resolve(__dirname, 'src') },
]);

export default defineConfig({
  resolve: { alias: [createWorkspaceHostSourceAlias(resolve(__dirname, '../../..'), resolve(__dirname, '../../../apps/cli/src'))] },
  server: { fs: { allow: [resolve(__dirname, '../../..')] } },
  // Agent tests compose the real CLI host, including its workspace dependencies.
  optimizeDeps: { exclude: workspacePackages.map(spec => spec.packageName) },
  plugins: [createWorkspacePackageSourcesPlugin(workspacePackages)],
  test: {
    ...resolveVitestWorkers(),
    environment: 'node',
    // The real host grant composition uses its source harness in the second lane.
    exclude: [...configDefaults.exclude, '**/interactions.mcpApprovalSubject.test.ts', '**/mcpToolPolicy.contract.test.ts'],
  },
});
