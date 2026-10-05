import { resolveVitestWorkers } from '../../scripts/testing/vitestWorkers';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { createWorkspacePackageSourcesPlugin } from '../../scripts/testing/vitestWorkspacePackageResolution';

export default defineConfig({
  test: { ...resolveVitestWorkers(), include: ['src/**/*.test.ts', 'src/**/*.spec.ts'], environment: 'node' },
  plugins: [createWorkspacePackageSourcesPlugin([
    { packageName: '@happier-dev/protocol', packageSourceRoot: fileURLToPath(new URL('../protocol/src', import.meta.url)) },
    { packageName: '@happier-dev/agents', packageSourceRoot: fileURLToPath(new URL('../agents/src', import.meta.url)) },
  ])],
});
