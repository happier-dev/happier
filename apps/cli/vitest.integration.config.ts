import { configDefaults, defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

import dotenv from 'dotenv'
import { createTestHomeEnvironment } from '../../scripts/testing/testHomeEnvironment.mjs'
import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating'
import cliVitestConfig from './vitest.config'

const testEnv = dotenv.config({
    path: '.env.integration-test'
}).parsed

const mergedTestEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...testEnv,
};
const workspaceSyncRealIntegrationTest = 'src/daemon/startup/createDaemonWorkspaceSyncRuntime.real.integration.test.ts';
const workspaceSyncBrokerGoRealIntegrationTest = 'src/workspaces/sync/transport/workspaceSyncBroker.go.real.integration.test.ts';
const workspaceMachineCarrierRealIntegrationTest = 'src/daemon/peer/iroh/workspaceMachineCarrierLane08.real.integration.test.ts';
const workspaceMachineCarrierMutagenRealIntegrationTest = 'src/daemon/peer/iroh/workspaceMachineCarrierMutagen.real.integration.test.ts';
// The external Session-Agent author-journey canary runs the real managed
// author toolchain: it materializes dependencies from real registries and
// compiles/bundles a scaffolded plugin, so it needs network access and takes
// far longer than an ordinary integration file. Keep it opt-in like the other
// real-dependency rows above rather than making this lane network-bound.
const sessionAgentCanaryRealIntegrationTest = 'src/cli/commands/plugins.sessionAgentCanary.real.integration.test.ts';

if (mergedTestEnv.HAPPIER_SERVER_URL && !mergedTestEnv.HAPPIER_WEBAPP_URL) {
    mergedTestEnv.HAPPIER_WEBAPP_URL = mergedTestEnv.HAPPIER_SERVER_URL;
}

// CLI tests should not inherit embedded build-policy gating (set in CI).
// Clear it by default so feature tests can opt-in explicitly per case.
mergedTestEnv.HAPPIER_FEATURE_POLICY_ENV = '';

export default defineConfig({
    ...cliVitestConfig,
    // Vite/Vitest source maps for large TS module graphs can consume a lot of memory.
    // Integration tests in this repo don't require sourcemaps to assert behavior.
    esbuild: {
        ...cliVitestConfig.esbuild,
        sourcemap: false,
    },
    test: {
        // Ensure per-file module isolation so long-running integration suites don't
        // retain large module graphs across files (can otherwise OOM in single-fork mode).
        isolate: true,
        globals: false,
        environment: 'node',
        server: { deps: cliVitestConfig.test?.server?.deps },
        testTimeout: 60_000,
        hookTimeout: 60_000,
        // These integration tests mutate `process.env` (PATH overrides, server URLs, etc).
        // Running in a single fork avoids cross-file environment races.
        pool: 'forks',
        poolOptions: {
            forks: {
                singleFork: true,
            },
        },
        setupFiles: [fileURLToPath(new URL('../../scripts/testing/vitestHomeSetup.mjs', import.meta.url)), './src/configureZodLocale.ts', './src/vitestHomeGuard.ts'],
        sequence: { setupFiles: 'list' },
        include: [
            'src/**/*.integration.test.ts',
            'src/**/*.real.integration.test.ts',
            'src/**/*.integration.spec.ts',
            'src/**/*.e2e.test.ts',
            'scripts/**/*.integration.test.ts',
        ],
        exclude: [
            ...configDefaults.exclude,
            '**/._*',
            ...resolveVitestFeatureTestExcludeGlobs(process.env),
            ...(process.env.HAPPIER_RUN_MUTAGEN_REAL_INTEGRATION === '1'
                ? []
                : [workspaceSyncRealIntegrationTest, workspaceSyncBrokerGoRealIntegrationTest]),
            ...(process.env.HAPPIER_RUN_HOME_IROH_REAL_INTEGRATION === '1'
                ? []
                : [workspaceMachineCarrierRealIntegrationTest]),
            ...(process.env.HAPPIER_RUN_MUTAGEN_REAL_INTEGRATION === '1'
                && process.env.HAPPIER_RUN_HOME_IROH_REAL_INTEGRATION === '1'
                ? []
                : [workspaceMachineCarrierMutagenRealIntegrationTest]),
            ...(process.env.HAPPIER_RUN_SESSION_AGENT_CANARY === '1'
                ? []
                : [sessionAgentCanaryRealIntegrationTest]),
        ],
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
            ...createTestHomeEnvironment().env,
        }
    },
})
