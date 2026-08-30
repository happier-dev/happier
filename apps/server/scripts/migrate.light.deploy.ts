import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { openPgliteMigrationSession } from './pgliteMigrationSession';

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
    const session = await openPgliteMigrationSession(env, { purpose: 'script:migrate.light.deploy' });
    try {
        env.DATABASE_URL = session.databaseUrl;

        const require = createRequire(import.meta.url);
        const prismaCliPath = require.resolve('prisma/build/index.js');
        await run(process.execPath, [prismaCliPath, 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], env);
    } finally {
        await session.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
