import { mkdir, readdir } from 'node:fs/promises';
import { applyLightDefaultEnv } from '../sources/flavors/light/env';
import { runCommand } from './runCommand';

async function findBaselineMigrationDir(): Promise<string> {
    const entries = await readdir('prisma/sqlite/migrations', { withFileTypes: true });
    const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    const first = dirs[0];
    if (!first) {
        throw new Error('No prisma/sqlite/migrations/* directories found to use as a baseline.');
    }
    return first;
}

async function main() {
    const env: NodeJS.ProcessEnv = { ...process.env };
    applyLightDefaultEnv(env);

    const dataDir = env.HAPPY_SERVER_LIGHT_DATA_DIR ?? env.HAPPIER_SERVER_LIGHT_DATA_DIR!;
    await mkdir(dataDir, { recursive: true });

    await runCommand('yarn', ['-s', 'schema:sync', '--quiet'], env);

    const baseline = await findBaselineMigrationDir();
    await runCommand(
        'yarn',
        ['-s', 'prisma', 'migrate', 'resolve', '--schema', 'prisma/sqlite/schema.prisma', '--applied', baseline],
        env
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
