import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

import dotenv from 'dotenv';

const testEnv = dotenv.config({
  path: '.env.integration-test',
}).parsed ?? {};

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.slow.test.ts'],
    globalSetup: ['./src/test-setup.ts'],
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
    },
  },
  resolve: {
    alias: {
      '@': resolve('./src'),
    },
  },
});
