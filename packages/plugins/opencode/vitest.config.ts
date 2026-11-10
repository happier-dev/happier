import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { createWorkspaceHostSourceAlias, createWorkspacePackageSourcesPlugin, readHostWorkspacePackageSpecs } from '../../../scripts/testing/vitestWorkspacePackageResolution';

export default defineConfig({
  plugins: [createWorkspacePackageSourcesPlugin(readHostWorkspacePackageSpecs(
    resolve(__dirname, '../../..'), resolve(__dirname, '../../../apps/cli'),
  ))],
  resolve: { alias: [createWorkspaceHostSourceAlias(
    resolve(__dirname, '../../..'), resolve(__dirname, '../../../apps/cli/src'),
  )] },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [
      'src/agent/mcpToolPolicy.contract.test.ts',
      'src/agent/runtime/server/runtime.test.ts',
      'src/agent/runtime/server/openCodeServerClient.test.ts',
    ],
  },
});
