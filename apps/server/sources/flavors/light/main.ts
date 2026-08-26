import 'reflect-metadata';
import 'dotenv/config';

import { initializeServerSentry } from '@/app/monitoring/sentry';
import { resolveServerFlavorFromEnv } from '@/config/backends';
import {
    applyLightDefaultEnv,
    applyPackagedLightRuntimeSqliteDefaults,
    resolveLightDataDir,
} from '@/flavors/light/env';
import { applySqliteMigrationsFromEnvironment } from '@/flavors/light/sqliteMigrations';
import { registerProcessHandlers } from '@/utils/process/processHandlers';

export async function runLightServerMain(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
    const flavor = argv.includes('--migrate-only')
        ? 'light'
        : resolveServerFlavorFromEnv(process.env, 'light');
    process.env.HAPPY_SERVER_FLAVOR = flavor;
    process.env.HAPPIER_SERVER_FLAVOR = flavor;

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
    await startServer(flavor);
}
