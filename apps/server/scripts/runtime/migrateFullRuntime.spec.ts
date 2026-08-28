import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runFullRuntimeMigration } from './migrateFullRuntime';

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
            env: { HAPPIER_DB_PROVIDER: 'pglite', HAPPIER_SERVER_LIGHT_DB_DIR: '/data/pglite' },
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
