import { resolveVitestWorkers } from '../../scripts/testing/vitestWorkers';
import { defineConfig, mergeConfig } from 'vitest/config';

import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';
import { createUiProductionHooksVitestConfig } from './vitest.uiProductionHooks';

export default mergeConfig(createUiProductionHooksVitestConfig(), defineConfig({
  test: {
    ...resolveVitestWorkers(),
    environment: 'node',
    include: [
      'suites/contracts/**/*.test.ts',
      'suites/core-layer/**/*.test.ts',
      'suites/core-e2e/**/*.test.ts',
      'suites/runtime-unification/**/*.test.ts',
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
}));
