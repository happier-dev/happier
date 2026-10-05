import { resolveVitestWorkers } from '../../scripts/testing/vitestWorkers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    ...resolveVitestWorkers(),
    include: ['src/**/*.test.ts'],
  },
});
