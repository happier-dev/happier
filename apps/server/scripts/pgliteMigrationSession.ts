import { mkdir } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

import { applyLightDefaultEnv } from '../sources/flavors/light/env';
import { acquirePgliteDirLock } from '../sources/storage/locks/pgliteLock';

export interface PgliteMigrationSession {
    databaseUrl: string;
    close(): Promise<void>;
}

export async function openPgliteMigrationSession(
    env: NodeJS.ProcessEnv,
    { purpose }: Readonly<{ purpose: string }>,
): Promise<PgliteMigrationSession> {
    applyLightDefaultEnv(env);
    const dbDir = String(env.HAPPIER_SERVER_LIGHT_DB_DIR ?? env.HAPPY_SERVER_LIGHT_DB_DIR ?? '').trim();
    if (!dbDir) throw new Error('PGlite database directory is required');
    await mkdir(dbDir, { recursive: true });

    const releaseLock = await acquirePgliteDirLock(dbDir, { purpose });
    let pglite: PGlite | null = null;
    let server: PGLiteSocketServer | null = null;
    try {
        pglite = new PGlite(dbDir);
        await pglite.waitReady;
        server = new PGLiteSocketServer({ db: pglite, host: '127.0.0.1', port: 0 });
        await server.start();

        const rawConnection = server.getServerConn();
        const url = (() => {
            try {
                return new URL(rawConnection);
            } catch {
                return new URL(`postgresql://postgres@${rawConnection}/postgres?sslmode=disable`);
            }
        })();
        url.searchParams.set('connection_limit', '1');

        return {
            databaseUrl: url.toString(),
            async close() {
                await server?.stop().catch(() => undefined);
                await pglite?.close().catch(() => undefined);
                await releaseLock().catch(() => undefined);
            },
        };
    } catch (error) {
        await server?.stop().catch(() => undefined);
        await pglite?.close().catch(() => undefined);
        await releaseLock().catch(() => undefined);
        throw error;
    }
}
