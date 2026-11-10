import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { createWorkspacePackageSourcesPlugin, readHostWorkspacePackageSpecs } from '../../../scripts/testing/vitestWorkspacePackageResolution';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';

export default defineConfig({
  root: __dirname,
  plugins: [createWorkspacePackageSourcesPlugin(readHostWorkspacePackageSpecs(
    resolve(__dirname, '../../..'), resolve(__dirname, '../../../apps/cli'),
    [{ packageName: '@happier-dev/plugins-kimi', packageSourceRoot: resolve(__dirname, 'src') }],
  ))],
  test: { ...resolveVitestWorkers(), environment: 'node' },
});
