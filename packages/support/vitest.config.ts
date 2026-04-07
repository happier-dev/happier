import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

export default defineConfig({
  resolve: {
    alias: {
      '@happier-dev/cli-common/output': resolve(repoRoot, 'packages/cli-common/src/output/index.ts'),
      '@happier-dev/cli-common/happierRuntime': resolve(repoRoot, 'packages/cli-common/src/happierRuntime/index.ts'),
      '@happier-dev/protocol': resolve(repoRoot, 'packages/protocol/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
