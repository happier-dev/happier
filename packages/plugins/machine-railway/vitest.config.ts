import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { createWorkspaceHostSourceAlias } from '../../../scripts/testing/vitestWorkspacePackageResolution.ts';
import { workspacePackageSourcesPlugin } from '../../../apps/cli/scripts/vitestWorkspacePackageResolution.ts';
const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  plugins: [workspacePackageSourcesPlugin],
  resolve: { alias: [createWorkspaceHostSourceAlias(resolve(root, '../../..'), resolve(root, '../../../apps/cli/src'))] },
  test: { ...resolveVitestWorkers(), environment: 'node', include: ['src/**/*.test.ts'] },
});
