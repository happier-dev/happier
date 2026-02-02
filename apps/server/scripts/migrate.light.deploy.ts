import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { applyLightDefaultEnv } from '@/flavors/light/env';
import { requireLightDataDir } from './migrate.light.deployPlan';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

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

async function main() {
    const env: NodeJS.ProcessEnv = { ...process.env };
    applyLightDefaultEnv(env);

    const dataDir = requireLightDataDir(env);
    await mkdir(dataDir, { recursive: true });

    const dbDir = env.HAPPY_SERVER_LIGHT_DB_DIR?.trim();
    if (!dbDir) {
        throw new Error('Missing HAPPY_SERVER_LIGHT_DB_DIR (set it or ensure applyLightDefaultEnv sets it)');
    }
    await mkdir(dbDir, { recursive: true });

    const pglite = new PGlite(dbDir);
    // Ensure pglite is ready before starting the socket server.
    await (pglite as any).waitReady;
    const server = new PGLiteSocketServer({ db: pglite, host: '127.0.0.1', port: 0 });
    await server.start();

    try {
        const url = (() => {
            const raw = server.getServerConn();
            try {
                return new URL(raw);
            } catch {
                return new URL(`postgresql://postgres@${raw}/postgres?sslmode=disable`);
            }
        })();
        url.searchParams.set('connection_limit', '1');
        env.DATABASE_URL = url.toString();

        await run('yarn', ['-s', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], env);
    } finally {
        await server.stop();
        await pglite.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
