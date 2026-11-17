import { RELAY_RUNTIME_IRREVERSIBLE_MIGRATIONS } from '@happier-dev/cli-common/firstPartyRuntime/server';
import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { openPgliteMigrationSession } from '../pgliteMigrationSession';
import { assertForwardRecoveryCapableUpdater } from '../../sources/app/runtime/updaterMigrationAdmission';
import { resolveMigrationEnv } from '../migrationEnv';
import { runPluginCollectionUsageMigrationDeployment } from '../../sources/app/plugins/data/collections/usageTotalsBackfill';

import {
    hasSessionSystemRecordContractMigration,
    runSessionSystemRecordFinalContractBackfill,
} from '../../sources/app/session/systemRecords/sessionSystemRecordBackfillExecution';
import {
    runSessionSystemRecordMigrationDeployment,
} from '../../sources/app/session/systemRecords/sessionSystemRecordMigrationDeployment';
import {
    createDbMaintenanceClient,
    type DbProvider,
    type PrismaClientType,
} from '../../sources/storage/db';

export interface FullRuntimeMigrationProcessBoundary {
    spawn(command: string, args: string[], options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        stdio: 'inherit';
    }): { error?: Error; status: number | null; signal: NodeJS.Signals | null };
}

interface FullRuntimeMigrationOptions {
    executablePath: string;
    env: NodeJS.ProcessEnv;
    processBoundary?: FullRuntimeMigrationProcessBoundary;
    pgliteBoundary?: FullRuntimePgliteBoundary;
}

type MigrationLedgerClient = Pick<PrismaClientType, '$connect' | '$disconnect' | '$queryRawUnsafe'>;

interface FullRuntimeMigrationLedgerCheckOptions {
    env: NodeJS.ProcessEnv;
    migrationName: string;
    createClient?: (provider: DbProvider, databaseUrl?: string) => Promise<MigrationLedgerClient>;
    pgliteBoundary?: FullRuntimePgliteBoundary;
}

export interface FullRuntimePgliteBoundary {
    open(env: NodeJS.ProcessEnv): Promise<Readonly<{
        databaseUrl: string;
        close(): Promise<void>;
    }>>;
}

function normalizeProvider(env: NodeJS.ProcessEnv): DbProvider {
    const rawProvider = String(env.HAPPIER_DB_PROVIDER ?? env.HAPPY_DB_PROVIDER ?? '').trim().toLowerCase();
    if (rawProvider === 'postgres' || rawProvider === 'postgresql') return 'postgres';
    if (rawProvider === 'mysql') return 'mysql';
    if (rawProvider === 'pglite') return 'pglite';
    if (rawProvider === 'sqlite') return 'sqlite';
    throw new Error(`[happier-server-migrate] unsupported database provider: ${rawProvider || '<empty>'}`);
}

function isMissingMigrationLedger(error: unknown): boolean {
    const message = String((error as { message?: unknown })?.message ?? error ?? '').toLowerCase();
    return message.includes('no such table')
        || message.includes('does not exist')
        || message.includes("doesn't exist")
        || message.includes('unknown table');
}

function assertMigrationName(value: string): string {
    const migrationName = String(value ?? '').trim();
    if (!/^\d{14}_[a-z0-9_]+$/.test(migrationName)) {
        throw new Error(`[happier-server-migrate] invalid Prisma migration name: ${migrationName || '<empty>'}`);
    }
    return migrationName;
}

export async function isFullRuntimeMigrationApplied({
    env,
    migrationName: rawMigrationName,
    createClient = createDbMaintenanceClient,
    pgliteBoundary = defaultPgliteBoundary,
}: FullRuntimeMigrationLedgerCheckOptions): Promise<boolean> {
    const provider = normalizeProvider(env);
    env = resolveMigrationEnv(env, provider);
    const migrationName = assertMigrationName(rawMigrationName);
    const configuredDatabaseUrl = String(env.DATABASE_URL ?? '').trim();
    if (provider !== 'pglite' && !configuredDatabaseUrl) {
        throw new Error('[happier-server-migrate] DATABASE_URL is required');
    }
    const pgliteSession = provider === 'pglite' ? await pgliteBoundary.open(env) : null;
    const databaseUrl = pgliteSession?.databaseUrl ?? configuredDatabaseUrl;
    const client = await createClient(provider, databaseUrl);
    let failed = false;
    try {
        await client.$connect();
        const rows = await client.$queryRawUnsafe<Array<{ migration_name?: unknown }>>(
            'SELECT migration_name FROM _prisma_migrations '
            + `WHERE migration_name = '${migrationName}' `
            + 'AND finished_at IS NOT NULL AND rolled_back_at IS NULL',
        );
        return rows.some((row) => row.migration_name === migrationName);
    } catch (error) {
        if (isMissingMigrationLedger(error)) return false;
        failed = true;
        throw error;
    } finally {
        try {
            await client.$disconnect();
        } catch (error) {
            if (!failed) throw error;
        } finally {
            await pgliteSession?.close();
        }
    }
}

async function requirePath(path: string, kind: 'file' | 'directory'): Promise<void> {
    const info = await stat(path).catch(() => null);
    const valid = kind === 'file' ? info?.isFile() : info?.isDirectory();
    if (!valid) throw new Error(`[happier-server-migrate] missing artifact-local ${kind}: ${path}`);
}

const defaultProcessBoundary: FullRuntimeMigrationProcessBoundary = {
    spawn(command, args, options) {
        return spawnSync(command, args, options);
    },
};

const defaultPgliteBoundary: FullRuntimePgliteBoundary = {
    open: async (env) => await openPgliteMigrationSession(env, { purpose: 'runtime:migrate' }),
};

class PackagedPrismaMigrationFailure extends Error {
    readonly exitCode: number;

    constructor(exitCode: number) {
        super(`[happier-server-migrate] packaged Prisma exited with code ${exitCode}`);
        this.exitCode = exitCode;
    }
}

export async function runFullRuntimeMigration({
    executablePath,
    env,
    processBoundary = defaultProcessBoundary,
    pgliteBoundary = defaultPgliteBoundary,
}: FullRuntimeMigrationOptions): Promise<number> {
    const provider = normalizeProvider(env);
    env = resolveMigrationEnv(env, provider);
    if (provider === 'sqlite') {
        throw new Error('[happier-server-migrate] unsupported database provider: sqlite');
    }
    const configuredDatabaseUrl = String(env.DATABASE_URL ?? '').trim();
    if (provider !== 'pglite' && !configuredDatabaseUrl) {
        throw new Error('[happier-server-migrate] DATABASE_URL is required');
    }

    const artifactRoot = dirname(resolve(executablePath));
    const isWindowsArtifact = executablePath.toLowerCase().endsWith('.exe');
    const runnerPath = join(artifactRoot, 'runtime', isWindowsArtifact ? 'prisma-migrate.exe' : 'prisma-migrate');
    const schemaEnginePath = join(artifactRoot, 'runtime', isWindowsArtifact ? 'schema-engine.exe' : 'schema-engine');
    const schemaWasmPath = join(artifactRoot, 'runtime', 'prisma_schema_build_bg.wasm');
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
    ]);
    const irreversibleMigrationPresence = await Promise.all(RELAY_RUNTIME_IRREVERSIBLE_MIGRATIONS.map(
        ({ name }) => stat(join(migrationRoot, name)).then((value) => value.isDirectory()).catch(() => false),
    ));
    if (irreversibleMigrationPresence.some(Boolean)) assertForwardRecoveryCapableUpdater(env);

    const pgliteSession = provider === 'pglite' ? await pgliteBoundary.open(env) : null;
    const databaseUrl = pgliteSession?.databaseUrl ?? configuredDatabaseUrl;
    const deploy = async (stageSchemaPath: string): Promise<void> => {
        const completion = processBoundary.spawn(runnerPath, ['migrate', 'deploy', '--schema', stageSchemaPath], {
            cwd: artifactRoot,
            env: {
                ...env,
                DATABASE_URL: databaseUrl,
                HAPPIER_DB_PROVIDER: provider,
                PRISMA_SCHEMA_ENGINE_BINARY: schemaEnginePath,
            },
            stdio: 'inherit',
        });
        if (completion.error) {
            throw new Error(`[happier-server-migrate] failed to launch packaged Prisma: ${completion.error.message}`);
        }
        if (completion.status === 0 && completion.signal === null) return;
        if (typeof completion.status === 'number' && completion.status !== 0) {
            throw new PackagedPrismaMigrationFailure(completion.status);
        }
        throw new PackagedPrismaMigrationFailure(1);
    };

    try {
        await runSessionSystemRecordMigrationDeployment({
            migrationsDir: migrationRoot,
            schemaPath,
            isContractApplied: async () => await hasSessionSystemRecordContractMigration({
                provider,
                databaseUrl,
            }),
            deploy: async (stage) => await runPluginCollectionUsageMigrationDeployment({
                provider, databaseUrl, env, migrationsDir: stage.migrationsDir, schemaPath: stage.schemaPath!,
                deploy: async (usageStage) => await deploy(usageStage.schemaPath!),
            }),
            runFinalContractBackfill: async () => {
                await runSessionSystemRecordFinalContractBackfill({ provider, databaseUrl });
            },
        });
        return 0;
    } catch (error) {
        if (error instanceof PackagedPrismaMigrationFailure) return error.exitCode;
        throw error;
    } finally {
        await pgliteSession?.close();
    }
}

const isMain = (import.meta as ImportMeta & { main?: boolean }).main === true;
if (isMain) {
    const migrationCheckPrefix = '--is-migration-applied=';
    const migrationCheckArg = process.argv.slice(2).find((arg) => arg.startsWith(migrationCheckPrefix));
    const operation = migrationCheckArg
        ? isFullRuntimeMigrationApplied({
            env: process.env,
            migrationName: migrationCheckArg.slice(migrationCheckPrefix.length),
        }).then((applied) => applied ? 0 : 3)
        : runFullRuntimeMigration({ executablePath: process.execPath, env: process.env });
    operation
        .then((code) => { process.exitCode = code; })
        .catch((error: unknown) => {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        });
}
