import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { createWorkspaceHostSourceAlias, createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { createTestHomeEnvironment } from '../../../scripts/testing/testHomeEnvironment.mjs';

export default defineConfig({
  plugins: [createWorkspacePackageSourcesPlugin([
    { packageName: '@happier-dev/plugin-sdk', packageSourceRoot: resolve(__dirname, '../../plugin-sdk/src') },
    { packageName: '@happier-dev/cli-common', packageSourceRoot: resolve(__dirname, '../../cli-common/src') },
    { packageName: '@happier-dev/agents', packageSourceRoot: resolve(__dirname, '../../agents/src') },
    { packageName: '@happier-dev/protocol', packageSourceRoot: resolve(__dirname, '../../protocol/src') },
    { packageName: '@happier-dev/sync-client', packageSourceRoot: resolve(__dirname, '../../sync-client/src') },
  ])],
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
