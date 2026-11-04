import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { createWorkspacePackageSourcesPlugin, readHostWorkspacePackageSpecs } from '../../../scripts/testing/vitestWorkspacePackageResolution.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  plugins: [createWorkspacePackageSourcesPlugin(readHostWorkspacePackageSpecs(resolve(root, '../../..'), root),
    'happier-machine-hetzner-source')],
  test: { ...resolveVitestWorkers(), environment: 'node' },
});
