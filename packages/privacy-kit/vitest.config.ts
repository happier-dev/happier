import { resolveVitestWorkers } from '../../scripts/testing/vitestWorkers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    ...resolveVitestWorkers(),
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.spec.ts'],
  }
});
