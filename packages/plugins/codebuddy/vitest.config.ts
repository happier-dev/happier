import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { createWorkspaceHostSourceAlias } from '../../../scripts/testing/vitestWorkspacePackageResolution';
import { workspacePackageSourcesPlugin } from '../../../apps/cli/scripts/vitestWorkspacePackageResolution';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';

export default defineConfig({
  plugins: [workspacePackageSourcesPlugin],
  resolve: { alias: [createWorkspaceHostSourceAlias(
    resolve(__dirname, '../../..'), resolve(__dirname, '../../../apps/cli/src'),
  )] },
  test: { ...resolveVitestWorkers(), environment: 'node', exclude: [...configDefaults.exclude, '.project/**'] },
});
