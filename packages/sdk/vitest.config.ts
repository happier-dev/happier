import { resolveVitestWorkers } from '../../scripts/testing/vitestWorkers';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { createWorkspacePackageSourcesPlugin } from '../../scripts/testing/vitestWorkspacePackageResolution.ts';

const workspacePackages = ['protocol', 'agents', 'session-core', 'sync-client', 'connection-supervisor'].map((name) => ({
  packageName: `@happier-dev/${name}`,
  packageSourceRoot: fileURLToPath(new URL(`../${name}/src/`, import.meta.url)),
}));

export default defineConfig({
  resolve: {
    alias: { '#http': fileURLToPath(new URL('./src/http/undiciHttp.ts', import.meta.url)) },
  },
  plugins: [createWorkspacePackageSourcesPlugin(workspacePackages, 'happier-sdk-workspace-package-sources')],
  optimizeDeps: { exclude: workspacePackages.map(({ packageName }) => packageName) },
  test: {
    ...resolveVitestWorkers(),
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
