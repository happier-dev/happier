import { mkdtemp, mkdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runFullRuntimeMigration } from './migrateFullRuntime';

const tempRoots: string[] = [];

async function createArtifactFixture(): Promise<{ executablePath: string; artifactRoot: string }> {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'happier-server-migrate-'));
    tempRoots.push(artifactRoot);
    const executablePath = join(artifactRoot, process.platform === 'win32' ? 'happier-server-migrate.exe' : 'happier-server-migrate');
    const runtimeDir = join(artifactRoot, 'runtime');
    await mkdir(join(artifactRoot, 'prisma', 'migrations', '20260719000100_pg'), { recursive: true });
    await mkdir(join(artifactRoot, 'prisma', 'mysql', 'migrations', '20260719000100_mysql'), { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    const queryEngineFileName = process.platform === 'win32'
        ? 'query_engine-windows.dll.node'
        : process.platform === 'darwin'
            ? `libquery_engine-darwin${process.arch === 'arm64' ? '-arm64' : ''}.dylib.node`
            : process.arch === 'arm64'
                ? 'libquery_engine-linux-arm64-openssl-3.0.x.so.node'
                : 'libquery_engine-debian-openssl-3.0.x.so.node';
    await mkdir(join(artifactRoot, 'generated', 'mysql-client'), { recursive: true });
    await mkdir(join(artifactRoot, 'node_modules', '.prisma', 'client'), { recursive: true });
    await writeFile(join(artifactRoot, 'prisma', 'schema.prisma'), '// postgres\n');
    await writeFile(join(artifactRoot, 'prisma', 'migrations', 'migration_lock.toml'), 'provider = "postgresql"\n');
    await writeFile(join(artifactRoot, 'prisma', 'migrations', '20260719000100_pg', 'migration.sql'), '-- pg\n');
    await writeFile(join(artifactRoot, 'prisma', 'mysql', 'schema.prisma'), '// mysql\n');
    await writeFile(join(artifactRoot, 'prisma', 'mysql', 'migrations', 'migration_lock.toml'), 'provider = "mysql"\n');
    await writeFile(join(artifactRoot, 'prisma', 'mysql', 'migrations', '20260719000100_mysql', 'migration.sql'), '-- mysql\n');
    await writeFile(join(runtimeDir, process.platform === 'win32' ? 'prisma-migrate.exe' : 'prisma-migrate'), 'runner\n', { mode: 0o755 });
    await writeFile(join(runtimeDir, process.platform === 'win32' ? 'schema-engine.exe' : 'schema-engine'), 'engine\n', { mode: 0o755 });
    await writeFile(join(runtimeDir, 'prisma_schema_build_bg.wasm'), 'wasm\n');
    await writeFile(join(artifactRoot, 'generated', 'mysql-client', queryEngineFileName), 'mysql engine\n');
    await writeFile(join(artifactRoot, 'node_modules', '.prisma', 'client', queryEngineFileName), 'postgres engine\n');
    return { executablePath, artifactRoot };
}

afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('runFullRuntimeMigration', () => {
    it.each([
        ['postgres', join('prisma', 'schema.prisma')],
        ['postgresql', join('prisma', 'schema.prisma')],
        ['mysql', join('prisma', 'mysql', 'schema.prisma')],
    ])('delegates %s to packaged Prisma migrate deploy with artifact-local inputs', async (provider, relativeSchema) => {
        const { executablePath, artifactRoot } = await createArtifactFixture();
        const calls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];

        const exitCode = await runFullRuntimeMigration({
            executablePath,
            env: {
                HAPPIER_DB_PROVIDER: provider,
                DATABASE_URL: `${provider}://artifact-test/database`,
                HAPPIER_STACK_PRISMA_MIGRATE: '0',
            },
            processBoundary: {
                spawn(command, args, options) {
                    calls.push({ command, args, cwd: options.cwd, env: options.env });
                    return { pid: 123, output: [], stdout: null, stderr: null, status: 0, signal: null };
                },
            },
        });

        expect(exitCode).toBe(0);
        expect(calls).toHaveLength(1);
        expect(basename(calls[0]!.command)).toBe(process.platform === 'win32' ? 'prisma-migrate.exe' : 'prisma-migrate');
        expect(calls[0]!.args).toEqual(['migrate', 'deploy', '--schema', join(artifactRoot, relativeSchema)]);
        expect(calls[0]!.cwd).toBe(artifactRoot);
        expect(calls[0]!.env.PRISMA_SCHEMA_ENGINE_BINARY).toBe(
            join(artifactRoot, 'runtime', process.platform === 'win32' ? 'schema-engine.exe' : 'schema-engine'),
        );
        expect(calls[0]!.env.PRISMA_QUERY_ENGINE_LIBRARY).toContain(
            provider === 'mysql' ? join('generated', 'mysql-client') : join('node_modules', '.prisma', 'client'),
        );
    });

    it('migrates pglite through the packaged Postgres schema and a provider-owned temporary socket', async () => {
        const { executablePath, artifactRoot } = await createArtifactFixture();
        const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
        let closed = false;
        const exitCode = await runFullRuntimeMigration({
            executablePath,
            env: { HAPPIER_DB_PROVIDER: 'pglite', HAPPIER_SERVER_LIGHT_DB_DIR: '/data/pglite' },
            pgliteBoundary: {
                async open() {
                    return {
                        databaseUrl: 'postgresql://postgres@127.0.0.1:54321/postgres?sslmode=disable',
                        close: async () => { closed = true; },
                    };
                },
            },
            processBoundary: {
                spawn(_command, args, options) {
                    calls.push({ args, env: options.env });
                    return { status: 0, signal: null };
                },
            },
        });

        expect(exitCode).toBe(0);
        expect(calls[0]?.args).toEqual(['migrate', 'deploy', '--schema', join(artifactRoot, 'prisma', 'schema.prisma')]);
        expect(calls[0]?.env.DATABASE_URL).toContain('127.0.0.1:54321');
        expect(closed).toBe(true);
    });

    it.each([
        [{ DATABASE_URL: 'postgres://artifact-test/database' }, 'provider'],
        [{ HAPPIER_DB_PROVIDER: 'sqlite', DATABASE_URL: 'sqlite://artifact-test/database' }, 'provider'],
        [{ HAPPIER_DB_PROVIDER: 'postgres' }, 'DATABASE_URL'],
    ])('fails closed before spawning for invalid environment %#', async (env, expectedError) => {
        const { executablePath } = await createArtifactFixture();
        let spawnCount = 0;

        await expect(runFullRuntimeMigration({
            executablePath,
            env,
            processBoundary: {
                spawn() {
                    spawnCount += 1;
                    throw new Error('must not spawn');
                },
            },
        })).rejects.toThrow(expectedError);
        expect(spawnCount).toBe(0);
    });

    it.each([
        [{ status: 23, signal: null }, 23],
        [{ status: null, signal: 'SIGTERM' }, 1],
    ])('returns non-zero when packaged Prisma does not complete successfully %#', async (completion, expectedCode) => {
        const { executablePath } = await createArtifactFixture();
        const exitCode = await runFullRuntimeMigration({
            executablePath,
            env: { HAPPIER_DB_PROVIDER: 'postgres', DATABASE_URL: 'postgres://artifact-test/database' },
            processBoundary: {
                spawn() {
                    return { pid: 123, output: [], stdout: null, stderr: null, ...completion };
                },
            },
        });
        expect(exitCode).toBe(expectedCode);
    });

    it('fails closed when the packaged Prisma closure is incomplete', async () => {
        const { executablePath, artifactRoot } = await createArtifactFixture();
        await unlink(join(artifactRoot, 'runtime', 'prisma_schema_build_bg.wasm'));
        let spawnCount = 0;
        await expect(runFullRuntimeMigration({
            executablePath,
            env: { HAPPIER_DB_PROVIDER: 'postgres', DATABASE_URL: 'postgres://artifact-test/database' },
            processBoundary: { spawn() {
                spawnCount += 1;
                return { status: 0, signal: null };
            } },
        })).rejects.toThrow('prisma_schema_build_bg.wasm');
        expect(spawnCount).toBe(0);
    });
});
