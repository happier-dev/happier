import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { createWorkspacePackageSourcesPlugin } from '../../scripts/testing/vitestWorkspacePackageResolution.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

export default defineConfig({
  plugins: [createWorkspacePackageSourcesPlugin([
    {
      packageName: '@happier-dev/protocol',
      packageSourceRoot: resolve(repoRoot, 'packages', 'protocol', 'src'),
    },
  ], 'happier-qa-fixtures-workspace-package-sources')],
  test: {
    environment: 'node',
    globals: false,
  },
});
