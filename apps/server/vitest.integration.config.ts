import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    include: [
      'sources/**/*.integration.spec.ts',
      'sources/**/*.integration.test.ts',
      'sources/**/*.real.integration.test.ts',
      'scripts/**/*.integration.spec.ts',
      'scripts/**/*.integration.test.ts',
      'scripts/**/*.real.integration.test.ts',
    ],
    isolate: true,
    env: {
      HAPPIER_FEATURE_POLICY_ENV: '',
      S3_HOST: 'localhost',
      S3_PORT: '9000',
      S3_USE_SSL: 'false',
      S3_ACCESS_KEY: 'test',
      S3_SECRET_KEY: 'test',
      S3_BUCKET: 'test'
    }
  },
  plugins: [tsconfigPaths({ projects: [resolve(__dirname, './tsconfig.json')] })]
});
