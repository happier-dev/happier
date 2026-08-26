import { defineConfig, mergeConfig } from 'vitest/config';

import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';
import { createUiProductionHooksVitestConfig } from './vitest.uiProductionHooks';

export default mergeConfig(createUiProductionHooksVitestConfig(), defineConfig({
  test: {
    environment: 'node',
    include: ['suites/stress/**/*.test.ts'],
    testTimeout: 1_200_000,
    hookTimeout: 1_200_000,
    fileParallelism: false,
    globals: false,
    exclude: [...resolveVitestFeatureTestExcludeGlobs()],
    env: {
      HAPPIER_FEATURE_POLICY_ENV: '',
    },
  },
}));
