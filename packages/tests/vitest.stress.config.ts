import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['suites/stress/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    globals: false,
  },
});

