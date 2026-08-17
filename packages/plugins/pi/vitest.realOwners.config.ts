import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution.ts';

const repositoryRoot = resolve(__dirname, '../../..');
const cliSourceRoot = resolve(repositoryRoot, 'apps/cli/src');

const preferWorkspaceTypeScriptSources = {
  name: 'happier-pi-real-owners-typescript-sources',
  enforce: 'pre' as const,
  resolveId(id: string, importer?: string) {
    const resolvedId = id.split('?')[0]!;
    if (
      resolvedId.startsWith(`${cliSourceRoot}/`)
      && resolvedId.endsWith('.js')
    ) {
      const sourcePath = `${resolvedId.slice(0, -3)}.ts`;
      return existsSync(sourcePath) ? sourcePath : null;
    }
    if (!importer || !id.startsWith('.')) return null;
    const importerPath = importer.split('?')[0]!;
    const sourcePath = resolve(
      dirname(importerPath),
      id.endsWith('.js') ? `${id.slice(0, -3)}.ts` : `${id}.ts`,
    );
    if (!sourcePath.startsWith(`${repositoryRoot}/`) || !existsSync(sourcePath)) {
      return null;
    }
    return sourcePath;
  },
  load(id: string) {
    const sourcePath = id.split('?')[0]!;
    if (
      sourcePath.startsWith(`${cliSourceRoot}/`)
      && sourcePath.endsWith('.js')
    ) {
      throw new Error(
        `Real-owner proof must not load an emitted CLI source sibling: ${sourcePath}`,
      );
    }
    return null;
  },
};

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    include: [
      'src/agent/auth/services/requestAuth/source.realOwners.test-support.ts',
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: [
      {
        find: '@',
        replacement: resolve(__dirname, '../../../apps/cli/src'),
      },
    ],
  },
  plugins: [
    createWorkspacePackageSourcesPlugin([
      {
        packageName: '@happier-dev/agents',
        packageSourceRoot: resolve(repositoryRoot, 'packages', 'agents', 'src'),
      },
      {
        packageName: '@happier-dev/cli-common',
        packageSourceRoot: resolve(repositoryRoot, 'packages', 'cli-common', 'src'),
      },
      {
        packageName: '@happier-dev/plugin-sdk',
        packageSourceRoot: resolve(repositoryRoot, 'packages', 'plugin-sdk', 'src'),
      },
      {
        packageName: '@happier-dev/protocol',
        packageSourceRoot: resolve(repositoryRoot, 'packages', 'protocol', 'src'),
      },
      {
        packageName: '@happier-dev/tests',
        packageSourceRoot: resolve(repositoryRoot, 'packages', 'tests', 'src'),
      },
    ], 'happier-pi-real-owners-workspace-package-sources'),
    preferWorkspaceTypeScriptSources,
  ],
});
