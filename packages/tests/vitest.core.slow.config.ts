import { defineConfig, mergeConfig } from 'vitest/config';

import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';
import { createUiProductionHooksVitestConfig } from './vitest.uiProductionHooks';

export default mergeConfig(createUiProductionHooksVitestConfig(), defineConfig({
  test: {
    environment: 'node',
    include: [
      'suites/core-e2e/**/*.slow.e2e.test.ts',
      'suites/core-e2e/workLoop.delegateAndReport.composed.spec.ts',
      'suites/core-e2e/workLoop.dispatchAndFleet.composed.spec.ts',
      'suites/core-e2e/workLoop.factoryAndIncident.composed.spec.ts',
      'suites/core-e2e/workLoop.incidentTaskSpine.composed.spec.ts',
      'suites/core-e2e/workLoop.questionsAndAttention.composed.spec.ts',
      'suites/core-e2e/workLoop.taskCommentsSecurity.composed.spec.ts',
      'suites/core-e2e/workLoop.tasksReadyClaimResult.composed.spec.ts',
    ],
    globalSetup: ['src/testkit/vitest/globalSetup.coreSlow.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    globals: false,
    exclude: [...resolveVitestFeatureTestExcludeGlobs()],
    // These suites are process/socket heavy and should run deterministically.
    fileParallelism: false,
    env: {
      HAPPIER_FEATURE_POLICY_ENV: '',
      HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
    },
  },
}));
