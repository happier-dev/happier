import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { openPgliteMigrationSession } from '../pgliteMigrationSession';

export interface FullRuntimeMigrationProcessBoundary {
    spawn(command: string, args: string[], options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        stdio: 'inherit';
    }): {
        error?: Error;
        status: number | null;
        signal: NodeJS.Signals | null;
    };
}

interface FullRuntimeMigrationOptions {
    executablePath: string;
    env: NodeJS.ProcessEnv;
    processBoundary?: FullRuntimeMigrationProcessBoundary;
    pgliteBoundary?: FullRuntimePgliteBoundary;
}

export interface FullRuntimePgliteBoundary {
    open(env: NodeJS.ProcessEnv): Promise<Readonly<{
        databaseUrl: string;
        close(): Promise<void>;
    }>>;
}

function normalizeProvider(env: NodeJS.ProcessEnv): 'postgres' | 'mysql' | 'pglite' {
    const rawProvider = String(env.HAPPIER_DB_PROVIDER ?? env.HAPPY_DB_PROVIDER ?? '').trim().toLowerCase();
    if (rawProvider === 'postgres' || rawProvider === 'postgresql') return 'postgres';
    if (rawProvider === 'mysql') return 'mysql';
    if (rawProvider === 'pglite') return 'pglite';
    throw new Error(`[happier-server-migrate] unsupported database provider: ${rawProvider || '<empty>'}`);
}

function resolveQueryEngineFileName(platform: NodeJS.Platform, arch: string): string {
    const targetKey = `${platform}-${arch}`;
    switch (targetKey) {
        case 'linux-x64': return 'libquery_engine-debian-openssl-3.0.x.so.node';
        case 'linux-arm64': return 'libquery_engine-linux-arm64-openssl-3.0.x.so.node';
        case 'darwin-x64': return 'libquery_engine-darwin.dylib.node';
        case 'darwin-arm64': return 'libquery_engine-darwin-arm64.dylib.node';
        case 'win32-x64': return 'query_engine-windows.dll.node';
        default: throw new Error(`[happier-server-migrate] unsupported runtime target: ${targetKey}`);
    }
}

async function requirePath(path: string, kind: 'file' | 'directory'): Promise<void> {
    const info = await stat(path).catch(() => null);
    const valid = kind === 'file' ? info?.isFile() : info?.isDirectory();
    if (!valid) {
        throw new Error(`[happier-server-migrate] missing artifact-local ${kind}: ${path}`);
    }
}

const defaultProcessBoundary: FullRuntimeMigrationProcessBoundary = {
    spawn(command, args, options) {
        return spawnSync(command, args, options);
    },
};

const defaultPgliteBoundary: FullRuntimePgliteBoundary = {
    open: async (env) => await openPgliteMigrationSession(env, { purpose: 'runtime:migrate' }),
};

export async function runFullRuntimeMigration({
    executablePath,
    env,
    processBoundary = defaultProcessBoundary,
    pgliteBoundary = defaultPgliteBoundary,
}: FullRuntimeMigrationOptions): Promise<number> {
    const provider = normalizeProvider(env);
    const configuredDatabaseUrl = String(env.DATABASE_URL ?? '').trim();
    if (provider !== 'pglite' && !configuredDatabaseUrl) {
        throw new Error('[happier-server-migrate] DATABASE_URL is required');
    }

    const artifactRoot = dirname(resolve(executablePath));
    const isWindowsArtifact = executablePath.toLowerCase().endsWith('.exe');
    const runnerPath = join(artifactRoot, 'runtime', isWindowsArtifact ? 'prisma-migrate.exe' : 'prisma-migrate');
    const schemaEnginePath = join(artifactRoot, 'runtime', isWindowsArtifact ? 'schema-engine.exe' : 'schema-engine');
    const schemaWasmPath = join(artifactRoot, 'runtime', 'prisma_schema_build_bg.wasm');
    const queryEngineFileName = resolveQueryEngineFileName(process.platform, process.arch);
    const queryEnginePath = provider === 'mysql'
        ? join(artifactRoot, 'generated', 'mysql-client', queryEngineFileName)
        : join(artifactRoot, 'node_modules', '.prisma', 'client', queryEngineFileName);
    const schemaPath = provider === 'mysql'
        ? join(artifactRoot, 'prisma', 'mysql', 'schema.prisma')
        : join(artifactRoot, 'prisma', 'schema.prisma');
    const migrationRoot = provider === 'mysql'
        ? join(artifactRoot, 'prisma', 'mysql', 'migrations')
        : join(artifactRoot, 'prisma', 'migrations');
    const migrationLockPath = provider === 'mysql'
        ? join(artifactRoot, 'prisma', 'mysql', 'migrations', 'migration_lock.toml')
        : join(artifactRoot, 'prisma', 'migrations', 'migration_lock.toml');

    await Promise.all([
        requirePath(schemaPath, 'file'),
        requirePath(migrationRoot, 'directory'),
        requirePath(migrationLockPath, 'file'),
        requirePath(runnerPath, 'file'),
        requirePath(schemaEnginePath, 'file'),
        requirePath(schemaWasmPath, 'file'),
        requirePath(queryEnginePath, 'file'),
    ]);

    const pgliteSession = provider === 'pglite' ? await pgliteBoundary.open(env) : null;
    const databaseUrl = pgliteSession?.databaseUrl ?? configuredDatabaseUrl;
    try {
        const completion = processBoundary.spawn(
            runnerPath,
            ['migrate', 'deploy', '--schema', schemaPath],
            {
                cwd: artifactRoot,
                env: {
                    ...env,
                    DATABASE_URL: databaseUrl,
                    HAPPIER_DB_PROVIDER: provider,
                    PRISMA_SCHEMA_ENGINE_BINARY: schemaEnginePath,
                    PRISMA_QUERY_ENGINE_LIBRARY: queryEnginePath,
                },
                stdio: 'inherit',
            },
        );
        if (completion.error) {
            throw new Error(`[happier-server-migrate] failed to launch packaged Prisma: ${completion.error.message}`);
        }
        if (completion.status === 0 && completion.signal === null) return 0;
        if (typeof completion.status === 'number' && completion.status !== 0) return completion.status;
        return 1;
    } finally {
        await pgliteSession?.close();
    }
}

const isMain = (import.meta as ImportMeta & { main?: boolean }).main === true;
if (isMain) {
    runFullRuntimeMigration({ executablePath: process.execPath, env: process.env })
        .then((code) => {
            process.exitCode = code;
        })
        .catch((error: unknown) => {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        });
}
