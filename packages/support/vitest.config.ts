import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

import { createWorkspacePackageSourcesPlugin } from '../../scripts/testing/vitestWorkspacePackageResolution.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

export default defineConfig({
  plugins: [createWorkspacePackageSourcesPlugin([
    {
      packageName: '@happier-dev/agents',
      packageSourceRoot: resolve(repoRoot, 'packages', 'agents', 'src'),
    },
    {
      packageName: '@happier-dev/cli-common',
      packageSourceRoot: resolve(repoRoot, 'packages', 'cli-common', 'src'),
    },
    {
      packageName: '@happier-dev/protocol',
      packageSourceRoot: resolve(repoRoot, 'packages', 'protocol', 'src'),
    },
    {
      packageName: '@happier-dev/release-runtime',
      packageSourceRoot: resolve(repoRoot, 'packages', 'release-runtime', 'src'),
    },
  ], 'happier-support-workspace-package-sources')],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
