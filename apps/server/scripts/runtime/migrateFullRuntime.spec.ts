import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

import { isFullRuntimeMigrationApplied, runFullRuntimeMigration } from './migrateFullRuntime';
import { PLUGIN_COLLECTION_USAGE_EXPAND_MIGRATION, PLUGIN_COLLECTION_USAGE_BACKFILLED_MIGRATION } from '../../sources/app/plugins/data/collections/usageTotalsBackfill';

const tempRoots: string[] = [];

function queryEngineFileName(): string {
    if (process.platform === 'win32') return 'query_engine-windows.dll.node';
    if (process.platform === 'darwin') return `libquery_engine-darwin${process.arch === 'arm64' ? '-arm64' : ''}.dylib.node`;
    return process.arch === 'arm64'
        ? 'libquery_engine-linux-arm64-openssl-3.0.x.so.node'
        : 'libquery_engine-debian-openssl-3.0.x.so.node';
}

async function createArtifact(): Promise<{ root: string; executablePath: string }> {
    const root = await mkdtemp(join(tmpdir(), 'happier-server-migrate-dev-'));
    tempRoots.push(root);
    for (const path of [
        join(root, 'runtime'),
        join(root, 'prisma', 'migrations'),
        join(root, 'prisma', 'mysql', 'migrations'),
        join(root, 'generated', 'mysql-client'),
        join(root, 'node_modules', '.prisma', 'client'),
    ]) await mkdir(path, { recursive: true });
    await writeFile(join(root, 'prisma', 'schema.prisma'), '// pg\n');
    await writeFile(join(root, 'prisma', 'migrations', 'migration_lock.toml'), 'provider = "postgresql"\n');
    await writeFile(join(root, 'prisma', 'mysql', 'schema.prisma'), '// mysql\n');
    await writeFile(join(root, 'prisma', 'mysql', 'migrations', 'migration_lock.toml'), 'provider = "mysql"\n');
    await writeFile(join(root, 'runtime', process.platform === 'win32' ? 'prisma-migrate.exe' : 'prisma-migrate'), 'runner\n');
    await writeFile(join(root, 'runtime', process.platform === 'win32' ? 'schema-engine.exe' : 'schema-engine'), 'engine\n');
    await writeFile(join(root, 'runtime', 'prisma_schema_build_bg.wasm'), 'wasm\n');
    await writeFile(join(root, 'generated', 'mysql-client', queryEngineFileName()), 'mysql engine\n');
    await writeFile(join(root, 'node_modules', '.prisma', 'client', queryEngineFileName()), 'pg engine\n');
    return { root, executablePath: join(root, process.platform === 'win32' ? 'happier-server-migrate.exe' : 'happier-server-migrate') };
}

afterEach(async () => Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe('runFullRuntimeMigration', () => {
    it('backfills Collection usage before recording completion through the packaged migration entry', async () => {
        const artifact = await createArtifact();
        for (const name of [PLUGIN_COLLECTION_USAGE_EXPAND_MIGRATION, PLUGIN_COLLECTION_USAGE_BACKFILLED_MIGRATION]) {
            await mkdir(join(artifact.root, 'prisma', 'migrations', name));
            await writeFile(join(artifact.root, 'prisma', 'migrations', name, 'migration.sql'), 'SELECT 1;\n');
        }
        const require = createRequire(import.meta.url);
        const prismaPath = require.resolve('@prisma/client');
        const original = require(prismaPath) as typeof import('@prisma/client');
        const cached = require.cache[prismaPath]!;
        const events: string[] = [];
        let completed = false;
        // External DB-client boundary; the real deploy, stage and backfill orchestration stays intact.
        class MaintenanceClient {
            async $connect() {}
            async $disconnect() {}
            async $queryRawUnsafe() { return completed ? [{ migration_name: PLUGIN_COLLECTION_USAGE_BACKFILLED_MIGRATION }] : []; }
            account = { findFirst: async () => { events.push('backfill'); return null; } };
        }
        cached.exports = { ...original, PrismaClient: MaintenanceClient };
        const run = () => runFullRuntimeMigration({ executablePath: artifact.executablePath,
            env: { HAPPIER_DB_PROVIDER: 'postgres', DATABASE_URL: 'postgresql://fixture/fixture' },
            processBoundary: { spawn(_command, args) {
                const schemaPath = args[args.indexOf('--schema') + 1]!;
                const completion = existsSync(join(schemaPath, '..', 'migrations', PLUGIN_COLLECTION_USAGE_BACKFILLED_MIGRATION));
                events.push(completion ? 'complete' : 'expand');
                completed ||= completion;
                return { status: 0, signal: null };
            } },
        });
        try {
            await expect(run()).resolves.toBe(0);
            expect(events.indexOf('backfill')).toBeGreaterThan(events.indexOf('expand'));
            expect(events.indexOf('backfill')).toBeLessThan(events.indexOf('complete'));
            events.length = 0;
            await expect(run()).resolves.toBe(0);
            expect(events).toEqual(['complete']);
        } finally { cached.exports = original; }
    });

    it.each([['direct-connection', true], [undefined, false], ['', false], ['  ', false]])(
        'selects optional DIRECT_URL for the Postgres migration child (case %#)', async (directUrl, usesDirect) => {
            const artifact = await createArtifact();
            const env = { HAPPIER_DB_PROVIDER: 'postgres', DATABASE_URL: 'runtime-connection', DIRECT_URL: directUrl };
            const selections: boolean[] = [];
            await expect(runFullRuntimeMigration({
                executablePath: artifact.executablePath,
                env,
                processBoundary: { spawn(_command, _args, options) {
                    selections.push(options.env.DATABASE_URL === (usesDirect ? 'direct-connection' : 'runtime-connection'));
                    return { status: 0, signal: null };
                } },
            })).resolves.toBe(0);
            expect(selections).toEqual([true]);
            expect(env.DATABASE_URL === 'runtime-connection').toBe(true);
        },
    );

    it.each([
        '20260725100000_activate_qualified_connected_accounts_v4',
        '20260905220000_add_team_home_governance',
        '20260905235000_add_account_session_read_state',
        '20260906160100_contract_session_data_key_envelopes',
    ])('refuses %s before spawn without updater handoff', async (boundaryMigration) => {
        const artifact = await createArtifact();
        const migrationDir = join(artifact.root, 'prisma', 'migrations', boundaryMigration);
        await mkdir(migrationDir);
        // Candidate bytes come from the current checked-in migration. The predecessor
        // installer is the immutable cli-v0.2.11 tag at 98ea8fb76733b1dd785d38c31360179cafa84824;
        // its migration runner has no forward-recovery capability handoff.
        await writeFile(
            join(migrationDir, 'migration.sql'),
            await readFile(join(process.cwd(), 'prisma', 'migrations', boundaryMigration, 'migration.sql')),
        );
        let spawned = false;

        await expect(runFullRuntimeMigration({
            executablePath: artifact.executablePath,
            env: { HAPPIER_DB_PROVIDER: 'postgres', DATABASE_URL: 'postgres://artifact/database' },
            processBoundary: { spawn() { spawned = true; return { status: 0, signal: null }; } },
        })).rejects.toThrow(/forward-recovery-capable updater/u);
        expect(spawned).toBe(false);
    });

    it.each([
        '20260725100000_activate_qualified_connected_accounts_v4',
        '20260905220000_add_team_home_governance',
        '20260905235000_add_account_session_read_state',
        '20260906160100_contract_session_data_key_envelopes',
    ])('admits the current updater capability for %s', async (boundaryMigration) => {
        const artifact = await createArtifact();
        const migrationDir = join(artifact.root, 'prisma', 'migrations', boundaryMigration);
        await mkdir(migrationDir);
        await writeFile(
            join(migrationDir, 'migration.sql'),
            await readFile(join(process.cwd(), 'prisma', 'migrations', boundaryMigration, 'migration.sql')),
        );
        const calls: Array<{ env: NodeJS.ProcessEnv }> = [];

        await expect(runFullRuntimeMigration({
            executablePath: artifact.executablePath,
            env: {
                HAPPIER_DB_PROVIDER: 'postgres',
                DATABASE_URL: 'postgres://artifact/database',
                HAPPIER_UPDATER_FORWARD_RECOVERY_CAPABILITY: 'personal-home-update-record-v1',
            },
            processBoundary: { spawn(_command, _args, options) {
                calls.push({ env: options.env });
                return { status: 0, signal: null };
            } },
        })).resolves.toBe(0);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.env.HAPPIER_UPDATER_FORWARD_RECOVERY_CAPABILITY)
            .toBe('personal-home-update-record-v1');
    });

    it.each([
        ['postgresql', join('prisma', 'schema.prisma')],
        ['mysql', join('prisma', 'mysql', 'schema.prisma')],
    ])('uses only packaged %s migration inputs', async (provider, schemaPath) => {
        const artifact = await createArtifact();
        const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
        const code = await runFullRuntimeMigration({
            executablePath: artifact.executablePath,
            env: { HAPPIER_DB_PROVIDER: provider, DATABASE_URL: `${provider}://artifact/database` },
            processBoundary: { spawn(_command, args, options) {
                calls.push({ args, env: options.env });
                return { status: 0, signal: null };
            } },
        });
        expect(code).toBe(0);
        expect(calls[0]!.args).toEqual(['migrate', 'deploy', '--schema', join(artifact.root, schemaPath)]);
        expect(calls[0]!.env.PRISMA_SCHEMA_ENGINE_BINARY).toContain(join(artifact.root, 'runtime'));
        expect(calls[0]!.env.PRISMA_QUERY_ENGINE_LIBRARY).toContain(artifact.root);
    });

    it('opens one bounded PGlite migration session and reuses the PostgreSQL artifact closure', async () => {
        const artifact = await createArtifact();
        const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
        let closes = 0;
        const code = await runFullRuntimeMigration({
            executablePath: artifact.executablePath,
            env: { HAPPIER_DB_PROVIDER: 'pglite', HAPPIER_SERVER_LIGHT_DB_DIR: '/data/pglite', DIRECT_URL: 'direct-connection' },
            pgliteBoundary: {
                open: async () => ({
                    databaseUrl: 'postgresql://127.0.0.1:54321/postgres?connection_limit=1',
                    close: async () => { closes += 1; },
                }),
            },
            processBoundary: { spawn(_command, args, options) {
                calls.push({ args, env: options.env });
                return { status: 0, signal: null };
            } },
        });

        expect(code).toBe(0);
        expect(closes).toBe(1);
        expect(calls[0]!.args).toEqual(['migrate', 'deploy', '--schema', join(artifact.root, 'prisma', 'schema.prisma')]);
        expect(calls[0]!.env.HAPPIER_DB_PROVIDER).toBe('pglite');
        expect(calls[0]!.env.DATABASE_URL).toContain('127.0.0.1:54321');
    });

    it.each([
        [{ DATABASE_URL: 'postgres://artifact/database' }, 'provider'],
        [{ HAPPIER_DB_PROVIDER: 'sqlite', DATABASE_URL: 'sqlite://artifact/database' }, 'provider'],
        [{ HAPPIER_DB_PROVIDER: 'postgres' }, 'DATABASE_URL'],
    ])('fails closed before spawn for invalid environment %#', async (env, message) => {
        const artifact = await createArtifact();
        let spawned = false;
        await expect(runFullRuntimeMigration({
            executablePath: artifact.executablePath,
            env,
            processBoundary: { spawn() { spawned = true; return { status: 0, signal: null }; } },
        })).rejects.toThrow(message);
        expect(spawned).toBe(false);
    });
});

describe('isFullRuntimeMigrationApplied', () => {
    it.each([['direct-connection', true], [undefined, false], ['', false]])(
        'uses the migration connection for the Postgres ledger read (case %#)', async (directUrl, usesDirect) => {
            const selections: boolean[] = [];
            await expect(isFullRuntimeMigrationApplied({
                env: { HAPPIER_DB_PROVIDER: 'postgres', DATABASE_URL: 'runtime-connection', DIRECT_URL: directUrl },
                migrationName: '20260725100000_activate_qualified_connected_accounts_v4',
                createClient: async (_provider, databaseUrl) => {
                    selections.push(databaseUrl === (usesDirect ? 'direct-connection' : 'runtime-connection'));
                    return {
                        $connect: async () => undefined,
                        $disconnect: async () => undefined,
                        $queryRawUnsafe: async () => [],
                    };
                },
            })).resolves.toBe(false);
            expect(selections).toEqual([true]);
        },
    );

    it('reads the existing Prisma ledger completion fields for the exact migration', async () => {
        const queries: string[] = [];
        let disconnected = 0;
        const applied = await isFullRuntimeMigrationApplied({
            env: { HAPPIER_DB_PROVIDER: 'sqlite', DATABASE_URL: 'file:/data/home.sqlite' },
            migrationName: '20260725100000_activate_qualified_connected_accounts_v4',
            createClient: async () => ({
                $connect: async () => undefined,
                $disconnect: async () => { disconnected += 1; },
                $queryRawUnsafe: async (query: string) => {
                    queries.push(query);
                    return [{ migration_name: '20260725100000_activate_qualified_connected_accounts_v4' }];
                },
            }),
        });

        expect(applied).toBe(true);
        expect(disconnected).toBe(1);
        expect(queries[0]).toContain("migration_name = '20260725100000_activate_qualified_connected_accounts_v4'");
        expect(queries[0]).toContain('finished_at IS NOT NULL');
        expect(queries[0]).toContain('rolled_back_at IS NULL');
    });

    it('treats an absent migration ledger as pre-boundary but propagates other database failures', async () => {
        const createClient = async (message: string) => ({
            $connect: async () => undefined,
            $disconnect: async () => undefined,
            $queryRawUnsafe: async () => { throw new Error(message); },
        });
        await expect(isFullRuntimeMigrationApplied({
            env: { HAPPIER_DB_PROVIDER: 'postgres', DATABASE_URL: 'postgresql://db/home' },
            migrationName: '20260725100000_activate_qualified_connected_accounts_v4',
            createClient: async () => await createClient('relation _prisma_migrations does not exist'),
        })).resolves.toBe(false);
        await expect(isFullRuntimeMigrationApplied({
            env: { HAPPIER_DB_PROVIDER: 'postgres', DATABASE_URL: 'postgresql://db/home' },
            migrationName: '20260725100000_activate_qualified_connected_accounts_v4',
            createClient: async () => await createClient('connection refused'),
        })).rejects.toThrow(/connection refused/);
    });
});
