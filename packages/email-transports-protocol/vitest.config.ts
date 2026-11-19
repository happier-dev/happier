import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../scripts/testing/vitestWorkers';
import { createWorkspacePackageSourcesPlugin } from '../../scripts/testing/vitestWorkspacePackageResolution';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, '../..');

export default defineConfig({
  root: packageRoot,
  plugins: [createWorkspacePackageSourcesPlugin([
    { packageName: '@happier-dev/plugin-sdk', packageSourceRoot: resolve(repoRoot, 'packages/plugin-sdk/src') },
    { packageName: '@happier-dev/protocol', packageSourceRoot: resolve(repoRoot, 'packages/protocol/src') },
  ])],
  test: { ...resolveVitestWorkers(), environment: 'node', include: ['src/**/*.test.ts'], exclude: ['node_modules/**', 'dist/**'] },
});
