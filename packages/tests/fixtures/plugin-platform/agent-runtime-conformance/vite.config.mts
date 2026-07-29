import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

import {
  workspacePackageAliases,
  workspacePackageOptimizationExcludes,
  workspacePackageSourcesPlugin,
} from '../../../../../apps/cli/scripts/vitestWorkspacePackageResolution';

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(fixtureRoot, '../../../../..');

export default defineConfig({
  root: resolve(repoRoot, 'apps/cli'),
  optimizeDeps: {
    exclude: workspacePackageOptimizationExcludes,
  },
  resolve: {
    alias: [
      ...workspacePackageAliases,
      {
        find: '@',
        replacement: resolve(repoRoot, 'apps/cli/src'),
      },
    ],
  },
  plugins: [workspacePackageSourcesPlugin],
});
