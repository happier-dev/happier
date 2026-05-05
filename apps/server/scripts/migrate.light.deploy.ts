import { mkdir } from 'node:fs/promises';
import { applyLightDefaultEnv } from '../sources/flavors/light/env';
import { requireLightDataDir } from './migrate.light.deployPlan';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { acquirePgliteDirLock } from '../sources/storage/locks/pgliteLock';
import { applyPostgresMigrations } from './prismaMigrations';
import { resolveServerWorkspaceRoot } from './prismaCli';
import { join } from 'node:path';

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
    let server: PGLiteSocketServer | undefined;
    try {
        releaseLock = await acquirePgliteDirLock(dbDir, { purpose: 'script:migrate.light.deploy' });
        pglite = new PGlite(dbDir);
        // Ensure pglite is ready before starting the socket server.
        await pglite.waitReady;
        server = new PGLiteSocketServer({ db: pglite, host: '127.0.0.1', port: 0 });
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

        await applyPostgresMigrations({
            db: pglite,
            migrationsDir: join(serverRoot, 'prisma', 'migrations'),
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
