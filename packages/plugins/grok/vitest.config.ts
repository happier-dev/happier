import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { createWorkspacePackageSourcesPlugin, readHostWorkspacePackageSpecs } from '../../../scripts/testing/vitestWorkspacePackageResolution';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';

export default defineConfig({
  plugins: [createWorkspacePackageSourcesPlugin(readHostWorkspacePackageSpecs(resolve(__dirname, '../../..'), __dirname))],
  test: { ...resolveVitestWorkers(), environment: 'node' },
});
