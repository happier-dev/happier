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
    // Vite/Vitest source maps for large TS module graphs can consume a lot of memory.
    // Integration tests in this repo don't require sourcemaps to assert behavior.
    esbuild: {
        sourcemap: false,
    },
    test: {
        // Ensure per-file module isolation so long-running integration suites don't
        // retain large module graphs across files (can otherwise OOM in single-fork mode).
        isolate: true,
        globals: false,
        environment: 'node',
        testTimeout: 60_000,
        hookTimeout: 60_000,
        passWithNoTests: true,
        // These integration tests mutate `process.env` (PATH overrides, server URLs, etc).
        // Running in a single fork avoids cross-file environment races.
        pool: 'forks',
        poolOptions: {
            forks: {
                singleFork: true,
            },
        },
        include: [
            'src/**/*.integration.test.ts',
            'src/**/*.real.integration.test.ts',
            'src/**/*.integration.spec.ts',
            'src/**/*.e2e.test.ts',
            'scripts/**/*.integration.test.ts',
        ],
        exclude: [...configDefaults.exclude, ...resolveVitestFeatureTestExcludeGlobs(process.env)],
        globalSetup: ['./src/test-setup.integration.ts'],
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
