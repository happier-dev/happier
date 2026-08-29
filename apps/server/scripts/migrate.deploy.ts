import { requireDbProviderFromEnv, type DbProvider } from '../sources/storage/prisma';
import { runCommand } from './runCommand';
import { pathToFileURL } from 'node:url';

const MIGRATION_SCRIPT_BY_PROVIDER: Readonly<Record<DbProvider, string>> = Object.freeze({
    postgres: 'migrate:full:deploy',
    mysql: 'migrate:mysql:deploy',
    pglite: 'migrate:light:deploy',
    sqlite: 'migrate:sqlite:deploy',
});

export function resolveMigrationDeployScript(env: NodeJS.ProcessEnv): string {
    const provider = requireDbProviderFromEnv(env, 'postgres');
    return MIGRATION_SCRIPT_BY_PROVIDER[provider];
}

async function main(): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    await runCommand('yarn', ['-s', resolveMigrationDeployScript(env)], env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
