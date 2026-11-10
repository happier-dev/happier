import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { createWorkspacePackageSourcesPlugin, readHostWorkspacePackageSpecs } from '../../../scripts/testing/vitestWorkspacePackageResolution';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export default defineConfig({
  plugins: [createWorkspacePackageSourcesPlugin(readHostWorkspacePackageSpecs(repoRoot, dirname(fileURLToPath(import.meta.url))))],
  test: {
    ...resolveVitestWorkers(),
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
  },
});
