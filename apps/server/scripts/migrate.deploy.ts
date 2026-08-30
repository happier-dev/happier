import { requireDbProviderFromEnv, type DbProvider } from '../sources/storage/prisma';
import { runCommand } from './runCommand';
import { pathToFileURL } from 'node:url';

const MIGRATION_ARGS_BY_PROVIDER: Readonly<Record<DbProvider, readonly string[]>> = Object.freeze({
    postgres: ['prisma', 'migrate', 'deploy'],
    mysql: ['-s', 'migrate:mysql:deploy'],
    pglite: ['-s', 'migrate:light:deploy'],
    sqlite: ['-s', 'migrate:sqlite:deploy'],
});

export function resolveMigrationDeployArgs(env: NodeJS.ProcessEnv): string[] {
    const provider = requireDbProviderFromEnv(env, 'postgres');
    return [...MIGRATION_ARGS_BY_PROVIDER[provider]];
}

async function main(): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    await runCommand('yarn', resolveMigrationDeployArgs(env), env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
