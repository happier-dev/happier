import { defineConfig } from 'vitest/config';

import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'suites/core-e2e/**/*.test.ts',
      'src/testkit/cliAccessKey.spec.ts',
      'src/testkit/process/serverLight.plan.spec.ts',
      'src/testkit/process/extendedDbDocker.plan.spec.ts',
      'src/testkit/process/uiWebHtml.spec.ts',
      'src/testkit/env.spec.ts',
      'src/testkit/daemon/daemon.statePath.spec.ts',
      'src/testkit/providers/satisfaction/messageSatisfaction.spec.ts',
    ],
    exclude: ['suites/core-e2e/**/*.slow.e2e.test.ts', ...resolveVitestFeatureTestExcludeGlobs()],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    globals: false,
    env: {
      HAPPIER_FEATURE_POLICY_ENV: '',
    },
  },
});
