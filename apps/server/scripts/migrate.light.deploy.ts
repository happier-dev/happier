import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { applyLightDefaultEnv } from '@/flavors/light/env';
import { requireLightDataDir } from './migrate.light.deployPlan';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { acquirePgliteDirLock } from '@/storage/locks/pgliteLock';

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            env: env as Record<string, string>,
            stdio: 'inherit',
            shell: false,
        });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${cmd} exited with code ${code}`));
        });
    });
}

export async function runLightMigrateDeploy(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const nextEnv: NodeJS.ProcessEnv = { ...env };
    applyLightDefaultEnv(nextEnv);

    const dataDir = requireLightDataDir(nextEnv);
    await mkdir(dataDir, { recursive: true });

    const dbDir = nextEnv.HAPPY_SERVER_LIGHT_DB_DIR?.trim();
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
        nextEnv.DATABASE_URL = url.toString();

        const require = createRequire(import.meta.url);
        const prismaCliPath = require.resolve('prisma/build/index.js');
        await run(process.execPath, [prismaCliPath, 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], nextEnv);
    } finally {
        await server?.stop().catch(() => {});
        await pglite?.close().catch(() => {});
        await releaseLock?.().catch(() => {});
    }
}

export async function main(): Promise<void> {
    await runLightMigrateDeploy(process.env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
