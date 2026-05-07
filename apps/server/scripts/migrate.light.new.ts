import tmp from 'tmp';
import { renderPrismaCompatibleSqliteDatabaseUrl } from '@happier-dev/cli-common/firstPartyRuntime';
import { runCommand } from './runCommand';

function parseNameArg(argv: string[]): { name: string | null; passthrough: string[] } {
    const passthrough: string[] = [];
    let name: string | null = null;

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--name') {
            const next = argv[i + 1];
            if (!next) {
                throw new Error('Missing value for --name');
            }
            name = next;
            i++;
            continue;
        }
        if (a.startsWith('--name=')) {
            name = a.slice('--name='.length);
            continue;
        }
        passthrough.push(a);
    }

    return { name, passthrough };
}

async function main() {
    const { name, passthrough } = parseNameArg(process.argv.slice(2));
    if (!name || !name.trim()) {
        throw new Error('Missing --name. Example: yarn migrate:light:new -- --name add_my_table');
    }

    const env: NodeJS.ProcessEnv = { ...process.env };

    // Use an isolated temp DB file so creating migrations never touches a user's real light DB.
    const dbFile = tmp.fileSync({ prefix: 'happy-server-light-migrate-', postfix: '.sqlite' }).name;
    env.DATABASE_URL = renderPrismaCompatibleSqliteDatabaseUrl({ dbPath: dbFile, platform: process.platform });

    await runCommand('yarn', ['-s', 'schema:sync', '--quiet'], env);
    await runCommand(
        'yarn',
        [
            '-s',
            'prisma',
            'migrate',
            'dev',
            '--schema',
            'prisma/sqlite/schema.prisma',
            '--name',
            name,
            '--create-only',
            '--skip-generate',
            '--skip-seed',
            ...passthrough,
        ],
        env
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
