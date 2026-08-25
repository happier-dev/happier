import { defineConfig, mergeConfig } from 'vitest/config';

import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';
import { createUiProductionHooksVitestConfig } from './vitest.uiProductionHooks';

export default mergeConfig(createUiProductionHooksVitestConfig(), defineConfig({
  test: {
    environment: 'node',
    include: [
      'suites/contracts/**/*.test.ts',
      // In-process layer suites. They were reachable only through `test:core`, which no CI job and
      // no root CI-shaped script invokes, so 9 tests — including the agent approval-floor security
      // assertions and the only automated coverage of QA scenarios L2/L7 — executed nowhere.
      'suites/core-layer/**/*.test.ts',
      'suites/core-e2e/**/*.test.ts',
      'suites/runtime-unification/**/*.test.ts',
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
