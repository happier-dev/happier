import { readFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import {
    readSqliteMigrationCatalog,
    type SqliteMigrationCatalogEntry,
} from '../sqliteMigrationCatalog.js';
import { resolveManagedServerRuntimePaths } from '../serverRuntimeArtifactLayout.js';
import {
    parseEnvText,
    renderPrismaCompatibleSqliteDatabaseUrl,
    resolveSelfHostServerMigrationPlan,
    resolveServerLightSqliteDatabaseUrlOptionsFromEnv,
} from '../selfHostServerEnv.js';
import type { PersonalHomeRuntimeLayout } from './layout.js';
import { readSqlitePrismaMigrationLedger, type PrismaMigrationLedgerRow } from '../prismaMigrationLedger.js';

export type PersonalHomeSqliteMigrationFrontierErrorCode =
    | 'installed_catalog_empty'
    | 'migration_ledger_unavailable'
    | 'unknown_applied_migration'
    | 'migration_checksum_mismatch'
    | 'duplicate_active_migration'
    | 'unresolved_active_migration'
    | 'migration_frontier_missing'
    | 'manifest_schema_mismatch'
    | 'invalid_staged_database_path'
    | 'migration_process_failed'
    | 'migration_incomplete';

export class PersonalHomeSqliteMigrationFrontierError extends Error {
    readonly code: PersonalHomeSqliteMigrationFrontierErrorCode;

    constructor(code: PersonalHomeSqliteMigrationFrontierErrorCode, message: string) {
        super(message);
        this.name = 'PersonalHomeSqliteMigrationFrontierError';
        this.code = code;
    }
}

export type PersonalHomeSqliteMigrationRecord = Readonly<{
    name: string;
    checksum: string;
}>;

export type PersonalHomeSqliteMigrationFrontierFacts = Readonly<{
    schemaVersion: string;
    catalog: readonly SqliteMigrationCatalogEntry[];
    completedMigrations: readonly PersonalHomeSqliteMigrationRecord[];
    pendingMigrations: readonly string[];
}>;

export type PersonalHomeMigrationProcessRunner = (input: Readonly<{
    command: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
}>) => Promise<void>;

const DATA_AUTHORITY_ENV_KEYS = Object.freeze([
    'DATABASE_URL',
    'RUN_MIGRATIONS',
    'HAPPIER_STACK_PRISMA_MIGRATE',
    'HAPPIER_DB_PROVIDER',
    'HAPPY_DB_PROVIDER',
    'HAPPIER_SERVER_LIGHT_DATA_DIR',
    'HAPPY_SERVER_LIGHT_DATA_DIR',
    'HAPPIER_SERVER_LIGHT_DB_DIR',
    'HAPPY_SERVER_LIGHT_DB_DIR',
    'HAPPIER_SERVER_LIGHT_FILES_DIR',
    'HAPPY_SERVER_LIGHT_FILES_DIR',
    'HAPPIER_SQLITE_MIGRATIONS_DIR',
    'HAPPY_SQLITE_MIGRATIONS_DIR',
    'HAPPIER_SQLITE_AUTO_MIGRATE',
    'HAPPY_SQLITE_AUTO_MIGRATE',
] as const);

function fail(code: PersonalHomeSqliteMigrationFrontierErrorCode, message: string): never {
    throw new PersonalHomeSqliteMigrationFrontierError(code, message);
}

function normalizeChecksum(value: unknown): string {
    return String(value ?? '').trim().toLowerCase();
}

async function readLedger(databasePath: string): Promise<readonly PrismaMigrationLedgerRow[]> {
    try {
        return await readSqlitePrismaMigrationLedger(databasePath);
    } catch {
        return fail('migration_ledger_unavailable', 'The staged SQLite migration ledger is unavailable');
    }
}

export async function inspectPersonalHomeSqliteMigrationFrontier(params: Readonly<{
    databasePath: string;
    catalog: readonly SqliteMigrationCatalogEntry[];
    expectedSchemaVersion?: string;
}>): Promise<PersonalHomeSqliteMigrationFrontierFacts> {
    if (params.catalog.length === 0) {
        fail('installed_catalog_empty', 'The installed SQLite migration catalog is empty');
    }
    const catalogByName = new Map(params.catalog.map((migration) => [migration.name, migration]));
    const activeRows = (await readLedger(params.databasePath)).filter((row) => row.rolled_back_at == null);
    const activeNames = new Set<string>();
    const completedByName = new Map<string, PersonalHomeSqliteMigrationRecord>();

    for (const row of activeRows) {
        const name = String(row.migration_name ?? '').trim();
        if (activeNames.has(name)) {
            fail('duplicate_active_migration', 'The staged SQLite ledger contains a duplicate active migration');
        }
        activeNames.add(name);
        if (row.finished_at == null) {
            fail('unresolved_active_migration', 'The staged SQLite ledger contains an unresolved migration');
        }
        const migration = catalogByName.get(name);
        if (!migration) {
            fail('unknown_applied_migration', 'The staged SQLite ledger contains a migration absent from the installed runtime');
        }
        const checksum = normalizeChecksum(row.checksum);
        if (checksum !== migration.checksum) {
            fail('migration_checksum_mismatch', 'The staged SQLite ledger checksum does not match the installed runtime');
        }
        completedByName.set(name, { name, checksum });
    }

    const completedMigrations = params.catalog
        .filter((migration) => completedByName.has(migration.name))
        .map((migration) => completedByName.get(migration.name)!);
    const frontier = completedMigrations.at(-1);
    if (!frontier) {
        // A supported Personal Home backup is created after bootstrap, whose installed migration
        // pass establishes at least the baseline ledger row before identity-bearing data exists.
        fail('migration_frontier_missing', 'The staged SQLite ledger has no completed catalog frontier');
    }
    if (params.expectedSchemaVersion !== undefined && params.expectedSchemaVersion !== frontier.name) {
        fail('manifest_schema_mismatch', 'The backup manifest schema does not match its SQLite migration frontier');
    }

    return Object.freeze({
        schemaVersion: frontier.name,
        catalog: Object.freeze([...params.catalog]),
        completedMigrations: Object.freeze(completedMigrations),
        pendingMigrations: Object.freeze(params.catalog
            .filter((migration) => !completedByName.has(migration.name))
            .map((migration) => migration.name)),
    });
}

export function resolveInstalledPersonalHomeSqliteMigrationPaths(params: Readonly<{
    installRoot: string;
    platform?: NodeJS.Platform;
}>): Readonly<{
    serverBinaryPath: string;
    migrationsDir: string;
}> {
    const platform = params.platform ?? process.platform;
    const pathApi = platform === 'win32' ? win32 : posix;
    const runtime = resolveManagedServerRuntimePaths({ installRoot: params.installRoot, platform });
    return Object.freeze({
        serverBinaryPath: runtime.serverBinaryPath,
        migrationsDir: pathApi.join(runtime.runtimeRoot, 'prisma', 'sqlite', 'migrations'),
    });
}

function assertStagedDatabasePath(params: Readonly<{
    databasePath: string;
    platform: NodeJS.Platform;
}>): string {
    const pathApi = params.platform === 'win32' ? win32 : posix;
    const databasePath = pathApi.resolve(params.databasePath);
    const databaseDir = pathApi.dirname(databasePath);
    if (pathApi.basename(databasePath) !== 'home.sqlite' || pathApi.basename(databaseDir) !== 'database') {
        fail('invalid_staged_database_path', 'The staged SQLite database must use the verified archive database/home.sqlite path');
    }
    return pathApi.dirname(databaseDir);
}

function createMigrationEnv(params: Readonly<{
    persistedEnv: NodeJS.ProcessEnv;
    databasePath: string;
    stagedDataDir: string;
    migrationsDir: string;
    platform: NodeJS.Platform;
}>): NodeJS.ProcessEnv {
    const pathApi = params.platform === 'win32' ? win32 : posix;
    const env: NodeJS.ProcessEnv = { ...params.persistedEnv };
    for (const key of DATA_AUTHORITY_ENV_KEYS) delete env[key];
    env.HAPPIER_DB_PROVIDER = 'sqlite';
    env.DATABASE_URL = renderPrismaCompatibleSqliteDatabaseUrl({
        dbPath: params.databasePath,
        platform: params.platform,
        sqlite: resolveServerLightSqliteDatabaseUrlOptionsFromEnv(env),
    });
    env.HAPPIER_SERVER_LIGHT_DATA_DIR = params.stagedDataDir;
    env.HAPPIER_SERVER_LIGHT_DB_DIR = pathApi.dirname(params.databasePath);
    env.HAPPIER_SQLITE_MIGRATIONS_DIR = params.migrationsDir;
    env.HAPPIER_SQLITE_AUTO_MIGRATE = '0';
    return env;
}

export async function migrateStagedPersonalHomeSqliteDatabase(params: Readonly<{
    layout: Pick<PersonalHomeRuntimeLayout, 'installRoot' | 'configDir' | 'platform'>;
    databasePath: string;
    manifestSchemaVersion: string;
    runProcess: PersonalHomeMigrationProcessRunner;
}>): Promise<PersonalHomeSqliteMigrationFrontierFacts> {
    const platform = params.layout.platform;
    const stagedDataDir = assertStagedDatabasePath({
        databasePath: params.databasePath,
        platform,
    });
    const paths = resolveInstalledPersonalHomeSqliteMigrationPaths({
        installRoot: params.layout.installRoot,
        platform,
    });
    const catalog = await readSqliteMigrationCatalog(paths.migrationsDir);
    await inspectPersonalHomeSqliteMigrationFrontier({
        databasePath: params.databasePath,
        catalog,
        expectedSchemaVersion: params.manifestSchemaVersion,
    });

    const pathApi = platform === 'win32' ? win32 : posix;
    const persistedEnv = parseEnvText(await readFile(pathApi.join(params.layout.configDir, 'server.env'), 'utf8'));
    const env = createMigrationEnv({
        persistedEnv,
        databasePath: params.databasePath,
        stagedDataDir,
        migrationsDir: paths.migrationsDir,
        platform,
    });
    const migrationPlan = resolveSelfHostServerMigrationPlan({
        serverBinaryPath: paths.serverBinaryPath,
        env,
        platform,
    });
    if (!migrationPlan) {
        fail('migration_process_failed', 'The installed server migration command is unavailable');
    }
    try {
        await params.runProcess({
            command: migrationPlan.command,
            args: migrationPlan.args,
            env,
        });
    } catch {
        fail('migration_process_failed', 'The installed server failed to migrate the staged SQLite database');
    }

    const finalFacts = await inspectPersonalHomeSqliteMigrationFrontier({
        databasePath: params.databasePath,
        catalog,
    });
    if (finalFacts.pendingMigrations.length > 0) {
        fail('migration_incomplete', 'The installed server did not apply the complete SQLite migration catalog');
    }
    return finalFacts;
}
