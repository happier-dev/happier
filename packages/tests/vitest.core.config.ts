import { defineConfig } from 'vitest/config';
import { resolve as resolvePath } from 'node:path';

import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';

const repoRoot = resolvePath(__dirname, '../..');

export default defineConfig({
  resolve: {
    alias: {
      '@': resolvePath(repoRoot, 'apps/cli/src'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'suites/core-e2e/**/*.test.ts',
      'src/testkit/**/*.{test,spec}.ts',
    ],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    globals: false,
    exclude: [...resolveVitestFeatureTestExcludeGlobs()],
    env: {
      HAPPIER_FEATURE_POLICY_ENV: '',
    },
  },
});
