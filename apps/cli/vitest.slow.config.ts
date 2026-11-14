import { resolveVitestWorkers } from '../../scripts/testing/vitestWorkers';
import { configDefaults, defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createTestHomeEnvironment } from '../../scripts/testing/testHomeEnvironment.mjs';
import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';

const testEnv = dotenv.config({
  path: '.env.integration-test',
}).parsed ?? {};

export default defineConfig({
  test: {
    ...resolveVitestWorkers(),
    globals: false,
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: [fileURLToPath(new URL('../../scripts/testing/vitestAgentSetup.mjs', import.meta.url)), './src/configureZodLocale.ts', './src/vitestHomeGuard.ts'],
    sequence: { setupFiles: 'list' },
    include: ['src/**/*.slow.test.ts'],
    exclude: [...configDefaults.exclude, '**/._*', ...resolveVitestFeatureTestExcludeGlobs({ ...process.env, ...testEnv })],
    globalSetup: ['./src/test-setup.slow.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData/**',
      ],
    },
    env: {
      ...process.env,
      ...testEnv,
      HAPPIER_FEATURE_POLICY_ENV: '',
      ...createTestHomeEnvironment().env,
    },
  },
  resolve: {
    alias: {
      '@': resolve('./src'),
    },
  },
});
