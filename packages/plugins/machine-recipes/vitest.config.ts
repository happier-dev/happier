import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root,
  plugins: [createWorkspacePackageSourcesPlugin(['plugin-sdk', 'protocol', 'cli-common', 'agents', 'release-runtime'].map(name => ({
    packageName: `@happier-dev/${name}`, packageSourceRoot: resolve(root, `../../${name}/src`),
  })), 'happier-machine-recipes-source')],
  test: { ...resolveVitestWorkers(), environment: 'node', include: ['src/**/*.test.ts'], exclude: ['node_modules/**', 'dist/**'] },
});
