import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { createWorkspaceHostSourceAlias, createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';

export default defineConfig({
  resolve: { alias: [createWorkspaceHostSourceAlias(resolve(__dirname, '../../..'), resolve(__dirname, '../../../apps/cli/src'))] },
  server: { fs: { allow: [resolve(__dirname, '../../..')] } },
  plugins: [createWorkspacePackageSourcesPlugin([
    { packageName: '@happier-dev/plugin-sdk', packageSourceRoot: resolve(__dirname, '../../plugin-sdk/src') },
    { packageName: '@happier-dev/protocol', packageSourceRoot: resolve(__dirname, '../../protocol/src') },
    { packageName: '@happier-dev/agents', packageSourceRoot: resolve(__dirname, '../../agents/src') },
    { packageName: '@happier-dev/cli-common', packageSourceRoot: resolve(__dirname, '../../cli-common/src') },
  ])],
  test: {
    ...resolveVitestWorkers(),
    environment: 'node',
    // The real host grant composition uses its source harness in the second lane.
    exclude: [...configDefaults.exclude, '**/interactions.mcpApprovalSubject.test.ts', '**/mcpToolPolicy.contract.test.ts'],
  },
});
