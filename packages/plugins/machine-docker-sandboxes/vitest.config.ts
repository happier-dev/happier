import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  plugins: [createWorkspacePackageSourcesPlugin([
    { packageName: '@happier-dev/plugin-sdk', packageSourceRoot: resolve(root, '../../plugin-sdk/src') },
    { packageName: '@happier-dev/protocol', packageSourceRoot: resolve(root, '../../protocol/src') },
  ], 'happier-machine-docker-sandboxes-source')],
  test: { ...resolveVitestWorkers(), environment: 'node', include: ['src/**/*.test.ts'] },
});
