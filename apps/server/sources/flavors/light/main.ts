import 'reflect-metadata';
import 'dotenv/config';

import { initializeServerSentry } from '@/app/monitoring/sentry';
import {
    applyLightDefaultEnv,
    applyPackagedLightRuntimeSqliteDefaults,
    resolveLightDataDir,
} from '@/flavors/light/env';
import { applySqliteMigrationsFromEnvironment } from '@/flavors/light/sqliteMigrations';
import { registerProcessHandlers } from '@/utils/process/processHandlers';

export async function runLightServerMain(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
    process.env.HAPPY_SERVER_FLAVOR = 'light';
    process.env.HAPPIER_SERVER_FLAVOR = 'light';

    if (argv.includes('--migrate-only')) {
        applyLightDefaultEnv(process.env);
        applyPackagedLightRuntimeSqliteDefaults(process.env);
        await applySqliteMigrationsFromEnvironment({
            env: process.env,
            dataDir: resolveLightDataDir(process.env),
        });
        return;
    }

    // Initialize Sentry before importing the server runtime so auto-instrumentation can patch dependencies (Fastify, etc).
    initializeServerSentry(process.env);
    registerProcessHandlers();

    const { startServer } = await import('@/startServer');
    await startServer('light');
}
