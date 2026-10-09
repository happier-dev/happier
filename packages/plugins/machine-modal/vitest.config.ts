import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  resolve: { conditions: ['happier-source', 'node', 'import', 'default'] },
  plugins: [createWorkspacePackageSourcesPlugin([
    { packageName: '@happier-dev/plugin-sdk', packageSourceRoot: resolve(root, '../../plugin-sdk/src') },
    { packageName: '@happier-dev/protocol', packageSourceRoot: resolve(root, '../../protocol/src') },
  ], 'happier-machine-modal-source')],
  test: { ...resolveVitestWorkers(), environment: 'node', include: ['src/**/*.test.ts'],
    // Native createRequire uses the real package imports map and its built
    // worker prerequisite. Vite alone resolves the moving workspace sources;
    // a blanket Node source condition would load TS beneath node_modules.
    pool: 'forks',
  },
});
