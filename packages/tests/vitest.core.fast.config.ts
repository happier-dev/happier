import { defineConfig, mergeConfig } from 'vitest/config';

import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';
import { createUiProductionHooksVitestConfig } from './vitest.uiProductionHooks';

export default mergeConfig(createUiProductionHooksVitestConfig(), defineConfig({
  test: {
    environment: 'node',
    include: [
      'suites/contracts/**/*.test.ts',
      'suites/core-e2e/**/*.test.ts',
      'src/testkit/**/*.{test,spec}.ts',
    ],
    globalSetup: ['src/testkit/vitest/globalSetup.coreFast.ts'],
    exclude: ['suites/core-e2e/**/*.slow.e2e.test.ts', ...resolveVitestFeatureTestExcludeGlobs()],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    maxWorkers: 6,
    globals: false,
    env: {
      HAPPIER_FEATURE_POLICY_ENV: '',
      HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
    },
  },
}));
