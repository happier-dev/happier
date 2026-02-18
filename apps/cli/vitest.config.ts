import { configDefaults, defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

import dotenv from 'dotenv'
import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating'

const testEnv = dotenv.config({
    path: '.env.integration-test'
}).parsed

const mergedTestEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...testEnv,
};

if (mergedTestEnv.HAPPIER_SERVER_URL && !mergedTestEnv.HAPPIER_WEBAPP_URL) {
    mergedTestEnv.HAPPIER_WEBAPP_URL = mergedTestEnv.HAPPIER_SERVER_URL;
}

// CLI tests should not inherit embedded build-policy gating (set in CI).
// Clear it by default so feature tests can opt-in explicitly per case.
mergedTestEnv.HAPPIER_FEATURE_POLICY_ENV = '';

export default defineConfig({
    test: {
        // Multiple CLI unit tests mutate `process.env.HAPPIER_HOME_DIR` / config at runtime.
        // Running them in isolated forked processes prevents cross-file env races.
        pool: 'forks',
        globals: false,
        environment: 'node',
        setupFiles: ['./src/vitestSetup.ts'],
        include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
        exclude: [
            ...configDefaults.exclude,
            '**/*.slow.test.ts',
            '**/*.integration.test.ts',
            '**/*.real.integration.test.ts',
            '**/*.integration.spec.ts',
            '**/*.e2e.test.ts',
            ...resolveVitestFeatureTestExcludeGlobs(process.env),
        ],
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
            ...mergedTestEnv,
        }
    },
    resolve: {
        alias: {
            '@': resolve('./src'),
        },
    },
})
