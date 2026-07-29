import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{
      find: /^@happier-dev\/protocol$/,
      replacement: resolve(__dirname, '../../packages/protocol/src/index.ts'),
    }],
  },
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    include: ['scripts/externalSessionMaterializeRecovery.composed.integration.test.ts'],
    isolate: true,
    env: {
      HAPPIER_FEATURE_POLICY_ENV: '',
      S3_HOST: 'localhost',
      S3_PORT: '9000',
      S3_USE_SSL: 'false',
      S3_ACCESS_KEY: 'test',
      S3_SECRET_KEY: 'test',
      S3_BUCKET: 'test',
    },
  },
  plugins: [tsconfigPaths({
    projects: [
      resolve(__dirname, './tsconfig.json'),
      resolve(__dirname, '../cli/tsconfig.json'),
    ],
  })],
});
