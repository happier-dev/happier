import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    include: ['sources/**/*.test.ts', 'sources/**/*.spec.ts', 'scripts/**/*.test.ts', 'scripts/**/*.spec.ts'],
    exclude: ['**/*.dbcontract.spec.ts', '**/*.integration.spec.ts', '**/*.integration.test.ts', '**/*.real.integration.test.ts'],
    // Prevent hoisted module mocks from leaking across test files.
    // Several integration-style tests mock shared modules (e.g. "@/storage/inTx", "@/app/events/eventRouter").
    // Without isolation, those mocks can contaminate other files depending on execution order.
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
  // Restrict tsconfig resolution to server only.
  // Otherwise vite-tsconfig-paths may scan the repo and attempt to parse Expo tsconfigs.
  plugins: [tsconfigPaths({ projects: [resolve(__dirname, './tsconfig.json')] })]
}); 
