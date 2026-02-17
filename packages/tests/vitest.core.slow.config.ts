import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['suites/core-e2e/**/*.slow.e2e.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    globals: false,
    // These suites are process/socket heavy and should run deterministically.
    fileParallelism: false,
    env: {
      HAPPIER_FEATURE_POLICY_ENV: '',
    },
  },
});
