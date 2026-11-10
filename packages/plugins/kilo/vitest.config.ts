import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { createWorkspaceHostSourceAlias, createWorkspacePackageSourcesPlugin, readHostWorkspacePackageSpecs } from '../../../scripts/testing/vitestWorkspacePackageResolution';

const workspacePackages = readHostWorkspacePackageSpecs(resolve(__dirname, '../../..'), resolve(__dirname, '../../../apps/cli'), [
  { packageName: '@happier-dev/plugins-kilo', packageSourceRoot: resolve(__dirname, 'src') },
]);

export default defineConfig({
  resolve: { alias: [createWorkspaceHostSourceAlias(resolve(__dirname, '../../..'), resolve(__dirname, '../../../apps/cli/src'))] },
  optimizeDeps: { exclude: workspacePackages.map(spec => spec.packageName) },
  plugins: [createWorkspacePackageSourcesPlugin(workspacePackages)],
  test: { include: ['src/**/*.test.ts'], exclude: ['src/agent/mcpToolPolicy.contract.test.ts'] },
});
