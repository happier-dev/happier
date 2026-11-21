import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export default defineConfig({
  plugins: [createWorkspacePackageSourcesPlugin([
    { packageName: '@happier-dev/deployment-protocol', packageSourceRoot: resolve(repoRoot, 'packages/deployment-protocol/src') },
    { packageName: '@happier-dev/plugin-sdk', packageSourceRoot: resolve(repoRoot, 'packages/plugin-sdk/src') },
    { packageName: '@happier-dev/railway-api', packageSourceRoot: resolve(repoRoot, 'packages/railway-api/src') },
    { packageName: '@happier-dev/protocol', packageSourceRoot: resolve(repoRoot, 'packages/protocol/src') },
  ])],
  test: {
    ...resolveVitestWorkers(),
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
  },
});
