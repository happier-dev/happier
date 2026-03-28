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
    exclude: ['suites/core-e2e/**/*.slow.e2e.test.ts', ...resolveVitestFeatureTestExcludeGlobs()],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    globals: false,
    env: {
      HAPPIER_FEATURE_POLICY_ENV: '',
      HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
    },
  },
});
