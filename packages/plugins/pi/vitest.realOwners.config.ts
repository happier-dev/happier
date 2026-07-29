import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

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
        find: '@happier-dev/cli-common/process',
        replacement: resolve(
          __dirname,
          '../../../packages/cli-common/src/process/index.ts',
        ),
      },
      {
        find: '@',
        replacement: resolve(__dirname, '../../../apps/cli/src'),
      },
    ],
  },
  plugins: [
    preferWorkspaceTypeScriptSources,
  ],
});
