import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['suites/core-e2e/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    globals: false,
  },
});

