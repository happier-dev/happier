import { defineConfig } from 'vitest/config';

import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['suites/providers/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // NOTE: In some sandboxed environments, worker_threads cannot bind/listen on localhost (EPERM).
    // Provider E2E contract tests start real local servers, so prefer process-based isolation.
    pool: 'forks',
    globals: false,
    exclude: [...resolveVitestFeatureTestExcludeGlobs()],
    env: {
      HAPPIER_FEATURE_POLICY_ENV: '',
    },
  },
});
