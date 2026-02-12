import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

import dotenv from 'dotenv'

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

export default defineConfig({
    test: {
        globals: false,
        environment: 'node',
        testTimeout: 60_000,
        hookTimeout: 60_000,
        include: [
            'src/**/*.integration.test.ts',
            'src/**/*.real.integration.test.ts',
            'src/**/*.integration.spec.ts',
            'src/**/*.e2e.test.ts',
            'scripts/**/*.integration.test.ts',
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
