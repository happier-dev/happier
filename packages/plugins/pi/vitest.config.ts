import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { createWorkspaceHostSourceAlias, createWorkspacePackageSourcesPlugin, readHostWorkspacePackageSpecs } from '../../../scripts/testing/vitestWorkspacePackageResolution';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';

export default defineConfig({
  plugins: [createWorkspacePackageSourcesPlugin(readHostWorkspacePackageSpecs(
    resolve(__dirname, '../../..'), resolve(__dirname, '../../../apps/cli'),
  ))],
  resolve: { alias: [createWorkspaceHostSourceAlias(
    resolve(__dirname, '../../..'), resolve(__dirname, '../../../apps/cli/src'),
  )] },
  test: { ...resolveVitestWorkers(), environment: 'node',
    exclude: [
      ...configDefaults.exclude,
      '.project/**',
      'src/agent/tools/mcpToolPolicy.contract.test.ts',
      'src/agent/runtime/rpc/operations.test.ts',
    ],
  },
});
