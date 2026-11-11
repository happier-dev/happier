import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';
const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  plugins: [createWorkspacePackageSourcesPlugin(['plugin-sdk', 'protocol', 'cli-common'].map(name => ({
    packageName: '@happier-dev/' + name, packageSourceRoot: resolve(root, '../../' + name + '/src'),
  })), 'happier-machine-coder-source')],
  test: { ...resolveVitestWorkers(), environment: 'node', include: ['src/**/*.test.ts'] },
});
