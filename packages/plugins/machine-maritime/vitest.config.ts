import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { workspacePackageSourcesPlugin } from '../../../apps/cli/scripts/vitestWorkspacePackageResolution';
const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root,
  plugins: [workspacePackageSourcesPlugin],
  test: { ...resolveVitestWorkers(), environment: 'node', include: ['src/**/*.test.ts'] },
});
