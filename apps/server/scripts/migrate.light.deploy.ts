import { mkdir } from 'node:fs/promises';
import { applyLightDefaultEnv } from '../sources/flavors/light/env';
import { requireLightDataDir } from './migrate.light.deployPlan';
import { PGlite } from '@electric-sql/pglite';
import { FramedPgliteSocketServer } from '../sources/storage/pgliteFramedSocketServer.mjs';
import { acquirePgliteDirLock } from '../sources/storage/locks/pgliteLock';
import { applyPostgresMigrations } from './prismaMigrations';
import { resolveServerWorkspaceRoot } from './prismaCli';
import { join } from 'node:path';
import {
    hasSessionSystemRecordContractMigration,
    runSessionSystemRecordFinalContractBackfill,
} from '../sources/app/session/systemRecords/sessionSystemRecordBackfillExecution';
import {
    runSessionSystemRecordMigrationDeployment,
} from '../sources/app/session/systemRecords/sessionSystemRecordMigrationDeployment';
import { runPluginCollectionUsageMigrationDeployment } from '../sources/app/plugins/data/collections/usageTotalsBackfill';

async function main() {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const serverRoot = resolveServerWorkspaceRoot(import.meta.url);
    applyLightDefaultEnv(env);

    const dataDir = requireLightDataDir(env);
    await mkdir(dataDir, { recursive: true });

    const dbDir = env.HAPPY_SERVER_LIGHT_DB_DIR?.trim();
    if (!dbDir) {
        throw new Error('Missing HAPPY_SERVER_LIGHT_DB_DIR (set it or ensure applyLightDefaultEnv sets it)');
    }
    await mkdir(dbDir, { recursive: true });

    let releaseLock: (() => Promise<void>) | undefined;
    let pglite: PGlite | undefined;
    let server: FramedPgliteSocketServer | undefined;
    try {
        releaseLock = await acquirePgliteDirLock(dbDir, { purpose: 'script:migrate.light.deploy' });
        pglite = new PGlite(dbDir);
        // Ensure pglite is ready before starting the socket server.
        await pglite.waitReady;
        server = new FramedPgliteSocketServer({ db: pglite, host: '127.0.0.1', port: 0 });
        await server.start();

        const url = (() => {
            const raw = server!.getServerConn();
            try {
                return new URL(raw);
            } catch {
                return new URL(`postgresql://postgres@${raw}/postgres?sslmode=disable`);
            }
        })();
        url.searchParams.set('connection_limit', '1');
        env.DATABASE_URL = url.toString();

        const migrationsDir = join(serverRoot, 'prisma', 'migrations');
        await runSessionSystemRecordMigrationDeployment({
            migrationsDir,
            isContractApplied: async () => await hasSessionSystemRecordContractMigration({
                provider: 'pglite',
                databaseUrl: env.DATABASE_URL,
            }),
            deploy: async (stage) => {
                const totals = await runPluginCollectionUsageMigrationDeployment({ ...stage, provider: 'pglite', databaseUrl: env.DATABASE_URL, env,
                    deploy: async target => await applyPostgresMigrations({ db: pglite!, migrationsDir: target.migrationsDir }),
                });
                return totals.final;
            },
            runFinalContractBackfill: async () => {
                await runSessionSystemRecordFinalContractBackfill({
                    provider: 'pglite',
                    databaseUrl: env.DATABASE_URL,
                });
            },
        });
    } finally {
        await server?.stop().catch(() => {});
        await pglite?.close().catch(() => {});
        await releaseLock?.().catch(() => {});
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
