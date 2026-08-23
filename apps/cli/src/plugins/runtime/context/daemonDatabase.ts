import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';

import {
    PluginDaemonDatabaseContributionV1Schema,
    PluginContributionLocalIdSchema,
    PluginIdSchema,
    type PluginDaemonDatabaseContributionV1,
} from '@happier-dev/protocol';
import type {
    DaemonDatabase,
    DaemonDatabaseExecutionResult,
    DaemonDatabaseIncumbentQueryFixture,
    DaemonDatabaseMigration,
    DaemonDatabaseMigrationReadTransaction,
    DaemonDatabaseMigrationTransaction,
    DaemonDatabaseOperationOptions,
    DaemonDatabaseRow,
    DaemonDatabaseService,
    DaemonDatabaseTransaction,
    DaemonDatabaseValue,
} from '@happier-dev/plugin-sdk/storage';
import type {
    PluginDaemonDatabaseRuntimeProjection as SdkPluginDaemonDatabaseRuntimeProjection,
} from '@happier-dev/plugin-sdk';

import type { PluginStorePaths } from '@/plugins/store/paths';

import { PluginContextServiceError } from './errors';
import {
    createDaemonDatabaseWorkerClient,
    type DaemonDatabaseWorkerClient,
    type DaemonDatabaseWorkerAllRequestOptions,
    type DaemonDatabaseWorkerLease,
    type DaemonDatabaseWorkerRequestOptions,
} from './daemonDatabaseWorker';
import { normalizePluginStorageNamespace } from './pluginNamespace';

type DatabaseValue = DaemonDatabaseValue;
type DatabaseRow = DaemonDatabaseRow;
type DatabaseCancellation = DaemonDatabaseOperationOptions;
type DatabaseExecutionResult = DaemonDatabaseExecutionResult;
type DatabaseTransaction = DaemonDatabaseTransaction;
type DatabaseMigrationTransaction = DaemonDatabaseMigrationTransaction;
type DatabaseMigrationReadTransaction = DaemonDatabaseMigrationReadTransaction;
type DatabaseMigration = DaemonDatabaseMigration;
type DatabaseIncumbentQueryFixture = DaemonDatabaseIncumbentQueryFixture;
type DatabaseOpenOptions = Parameters<DaemonDatabaseService['database']>[1];
type ActiveDatabaseTransaction = DatabaseTransaction & Readonly<{ end: () => void }>;

type NormalizedDatabaseOpenOptions = Readonly<{
    migrations: readonly DatabaseMigration[];
    incumbentQueryFixture: DatabaseIncumbentQueryFixture;
    signal?: AbortSignal;
}>;

export type PluginDaemonDatabaseLimits = Readonly<{
    /** Host configuration; no unmeasured quota default is manufactured here. */
    maximumDatabaseBytes: number;
    maximumInputBytes: number;
    maximumResultBytes: number;
    maximumResultRows: number;
    maximumAffectedRows: number;
    maximumElapsedMs: number;
}>;

export type PluginDaemonDatabasePreparedContract = Readonly<{
    id: string;
    incumbentQueryFixtureId: string;
    incumbentQueryFixture: DatabaseIncumbentQueryFixture;
}>;

export type PluginDaemonDatabaseQuiescence = Readonly<{
    /** Restores the incumbent owner only when candidate preparation does not adopt. */
    resume(): Promise<void>;
}>;

type PreparedDatabaseContract = PluginDaemonDatabasePreparedContract;
type DatabaseStorageScope = DaemonDatabaseService;
type DatabaseHandle = DaemonDatabase;

export type PluginDaemonDatabaseOwner = Readonly<{
    /** The private producer that the public storage facade binds into `storage.daemon`. */
    storage: DatabaseStorageScope;
    /** Candidate lifecycle consumes this exact generation-owned fixture registry after adoption. */
    readPreparedContracts: () => readonly PreparedDatabaseContract[];
    /** Candidate preparation closes incumbent SQLite handles without retiring its generation. */
    quiesce: () => Promise<PluginDaemonDatabaseQuiescence>;
    /** Retirement/shutdown/removal waits for in-flight work, then releases OS handles. */
    close: () => Promise<void>;
}>;

type DatabaseEntry = {
    readonly localId: string;
    readonly filePath: string;
    readonly worker: DaemonDatabaseWorkerClient;
    tail: Promise<void>;
    initialized: Promise<void> | null;
    pageBytes: number;
    /** Connection-local SQLite policy is reapplied only when the child changes. */
    configuredWorkerSessionId: number | null;
    closed: boolean;
};

type SqliteRunResult = Readonly<{
    changes?: unknown;
    lastInsertRowid?: unknown;
    lastInsertRowId?: unknown;
}>;

const databaseOperationContext = new AsyncLocalStorage<ReadonlySet<DatabaseEntry>>();
const LEDGER_TABLE = '_happier_plugin_schema';
const DATABASE_FILE_SUFFIX = '.sqlite';

function fail(code: string, message: string, retryable = false): never {
    throw new PluginContextServiceError(code, message, retryable);
}

function requirePositiveSafeInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        fail('daemon_database_limits_invalid', `${name} must be a positive safe integer`);
    }
    return value;
}

function validateLimits(limits: PluginDaemonDatabaseLimits): PluginDaemonDatabaseLimits {
    return Object.freeze({
        maximumDatabaseBytes: requirePositiveSafeInteger(limits.maximumDatabaseBytes, 'maximumDatabaseBytes'),
        maximumInputBytes: requirePositiveSafeInteger(limits.maximumInputBytes, 'maximumInputBytes'),
        maximumResultBytes: requirePositiveSafeInteger(limits.maximumResultBytes, 'maximumResultBytes'),
        maximumResultRows: requirePositiveSafeInteger(limits.maximumResultRows, 'maximumResultRows'),
        maximumAffectedRows: requirePositiveSafeInteger(limits.maximumAffectedRows, 'maximumAffectedRows'),
        maximumElapsedMs: requirePositiveSafeInteger(limits.maximumElapsedMs, 'maximumElapsedMs'),
    });
}

function assertCurrent(params: Readonly<{
    signal: AbortSignal;
    isGenerationCurrent: () => boolean;
    operationSignal?: AbortSignal;
}>): void {
    if (params.signal.aborted || params.operationSignal?.aborted) {
        fail('daemon_database_cancelled', 'Plugin daemon database operation was cancelled', true);
    }
    if (!params.isGenerationCurrent()) {
        fail('plugin_generation_stale', 'Plugin daemon database invocation generation is stale');
    }
}

function assertDatabaseLocalId(value: string): string {
    const parsed = PluginContributionLocalIdSchema.safeParse(value);
    if (!parsed.success) {
        fail('daemon_database_id_invalid', 'Daemon database name must be a canonical bounded plugin-local id');
    }
    return parsed.data;
}

function assertRuntimeIdentity(value: string, label: string): string {
    const parsed = PluginContributionLocalIdSchema.safeParse(value);
    if (!parsed.success) {
        fail('daemon_database_declaration_mismatch', `${label} must be a canonical bounded local id`);
    }
    return parsed.data;
}

function assertMigrationSequence(
    migrations: readonly Readonly<{ version: number; id: string }>[],
    label: string,
): void {
    let previousVersion = 0;
    const ids = new Set<string>();
    for (const migration of migrations) {
        if (!Number.isSafeInteger(migration.version) || migration.version <= previousVersion) {
            fail('daemon_database_declaration_mismatch', `${label} migrations must be positive and strictly ascending`);
        }
        const id = assertRuntimeIdentity(migration.id, `${label} migration id`);
        if (ids.has(id)) {
            fail('daemon_database_declaration_mismatch', `${label} migration ids must be unique`);
        }
        ids.add(id);
        previousVersion = migration.version;
    }
}

function normalizeDatabaseOpenOptions(options: DatabaseOpenOptions): NormalizedDatabaseOpenOptions {
    return Object.freeze({
        migrations: Object.freeze([...(options.migrations ?? [])]),
        incumbentQueryFixture: options.incumbentQueryFixture,
        ...(options.signal ? { signal: options.signal } : {}),
    });
}

function byteLengthOfValue(value: DatabaseValue): number {
    if (value === null) return 1;
    if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
    if (typeof value === 'number') return 8;
    if (typeof value === 'bigint') return Buffer.byteLength(value.toString(), 'utf8');
    return value.byteLength;
}

function assertDatabaseValue(value: unknown): asserts value is DatabaseValue {
    if (value === null || typeof value === 'string' || typeof value === 'bigint') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (value instanceof Uint8Array) return;
    fail('daemon_database_value_invalid', 'SQLite parameters and results must use supported scalar values');
}

function assertParameters(params: readonly DatabaseValue[], maximumInputBytes: number, sql: string): void {
    let total = Buffer.byteLength(sql, 'utf8');
    for (const value of params) {
        assertDatabaseValue(value);
        total += byteLengthOfValue(value);
        if (total > maximumInputBytes) {
            fail('daemon_database_input_too_large', 'SQLite statement input exceeds the daemon database limit');
        }
    }
    if (total > maximumInputBytes) {
        fail('daemon_database_input_too_large', 'SQLite statement input exceeds the daemon database limit');
    }
}

/**
 * SQLite's Node/Bun sync adapters expose a prepared statement but not the
 * parser tail pointer. This is intentionally a one-statement boundary scan,
 * not a migration splitter: SQLite still parses the submitted source, while
 * this scan refuses any non-comment token after the first complete statement.
 */
function stripCommentsAndValidateTail(sql: string): string {
    let state: 'plain' | 'single' | 'double' | 'backtick' | 'bracket' | 'lineComment' | 'blockComment' = 'plain';
    let sawTerminator = false;
    let stripped = '';

    for (let index = 0; index < sql.length; index += 1) {
        const character = sql[index]!;
        const next = sql[index + 1];

        if (state === 'lineComment') {
            if (character === '\n' || character === '\r') {
                state = 'plain';
                stripped += ' ';
            }
            continue;
        }
        if (state === 'blockComment') {
            if (character === '*' && next === '/') {
                index += 1;
                state = 'plain';
                stripped += ' ';
            }
            continue;
        }
        if (state === 'single') {
            stripped += ' ';
            if (character === "'") {
                if (next === "'") {
                    index += 1;
                    stripped += ' ';
                } else {
                    state = 'plain';
                }
            }
            continue;
        }
        if (state === 'double') {
            stripped += character;
            if (character === '"') {
                if (next === '"') {
                    index += 1;
                    stripped += next;
                } else {
                    state = 'plain';
                }
            }
            continue;
        }
        if (state === 'backtick') {
            stripped += character;
            if (character === '`') {
                if (next === '`') {
                    index += 1;
                    stripped += next;
                } else {
                    state = 'plain';
                }
            }
            continue;
        }
        if (state === 'bracket') {
            stripped += character;
            if (character === ']') state = 'plain';
            continue;
        }

        if (character === '-' && next === '-') {
            index += 1;
            state = 'lineComment';
            stripped += ' ';
            continue;
        }
        if (character === '/' && next === '*') {
            index += 1;
            state = 'blockComment';
            stripped += ' ';
            continue;
        }
        if (character === "'") {
            state = 'single';
            stripped += ' ';
            continue;
        }
        if (character === '"') {
            state = 'double';
            stripped += character;
            continue;
        }
        if (character === '`') {
            state = 'backtick';
            stripped += character;
            continue;
        }
        if (character === '[') {
            state = 'bracket';
            stripped += character;
            continue;
        }
        if (character === ';') {
            if (sawTerminator) {
                fail('daemon_database_statement_tail', 'SQLite statement contains more than one statement terminator');
            }
            sawTerminator = true;
            stripped += ' ';
            continue;
        }
        if (sawTerminator && !/\s/u.test(character)) {
            fail('daemon_database_statement_tail', 'SQLite statement has executable parser tail bytes');
        }
        stripped += character;
    }

    if (state === 'blockComment' || state === 'single' || state === 'double' || state === 'backtick' || state === 'bracket') {
        fail('daemon_database_sql_invalid', 'SQLite statement has an unterminated token');
    }
    if (!stripped.trim()) {
        fail('daemon_database_sql_invalid', 'SQLite statement must not be empty');
    }
    return stripped;
}

function firstSqlKeyword(stripped: string): string {
    const keyword = /[A-Za-z_][A-Za-z0-9_]*/u.exec(stripped)?.[0];
    if (!keyword) fail('daemon_database_sql_invalid', 'SQLite statement has no command keyword');
    return keyword.toUpperCase();
}

/**
 * Fixture callbacks receive the read-only transaction surface, but plugins can
 * still call it from untyped runtime code. A CTE is read-only only when its
 * top-level statement is SELECT; `WITH … INSERT`, `UPDATE`, and `DELETE` must
 * remain unavailable to incumbent fixtures.
 */
function isReadOnlyFixtureStatement(executableSource: string, keyword: string): boolean {
    if (keyword === 'SELECT') return true;
    if (keyword !== 'WITH') return false;

    let quote: 'plain' | 'double' | 'backtick' | 'bracket' = 'plain';
    let depth = 0;
    let awaitingCteBody = false;
    let cteBodyDepth: number | null = null;
    let completedCte = false;

    for (let index = 0; index < executableSource.length; index += 1) {
        const character = executableSource[index]!;
        const next = executableSource[index + 1];

        if (quote === 'double') {
            if (character === '"') {
                if (next === '"') index += 1;
                else quote = 'plain';
            }
            continue;
        }
        if (quote === 'backtick') {
            if (character === '`') {
                if (next === '`') index += 1;
                else quote = 'plain';
            }
            continue;
        }
        if (quote === 'bracket') {
            if (character === ']') quote = 'plain';
            continue;
        }
        if (character === '"') {
            quote = 'double';
            continue;
        }
        if (character === '`') {
            quote = 'backtick';
            continue;
        }
        if (character === '[') {
            quote = 'bracket';
            continue;
        }
        if (character === '(') {
            if (depth === 0 && awaitingCteBody) {
                cteBodyDepth = 1;
                awaitingCteBody = false;
            }
            depth += 1;
            continue;
        }
        if (character === ')') {
            if (depth === 0) return false;
            depth -= 1;
            if (depth === 0 && cteBodyDepth !== null) {
                cteBodyDepth = null;
                completedCte = true;
            }
            continue;
        }
        if (character === ',' && depth === 0 && completedCte) {
            completedCte = false;
            awaitingCteBody = false;
            continue;
        }
        if (!/[A-Z_]/u.test(character)) continue;

        let wordEnd = index + 1;
        while (wordEnd < executableSource.length && /[A-Z0-9_]/u.test(executableSource[wordEnd]!)) {
            wordEnd += 1;
        }
        const word = executableSource.slice(index, wordEnd);
        index = wordEnd - 1;

        if (depth !== 0) continue;
        if (completedCte) return word === 'SELECT';
        if (word === 'AS') awaitingCteBody = true;
    }

    return false;
}

function assertClassifiedPluginStatement(params: Readonly<{
    sql: string;
    mode: 'ordinary' | 'migration' | 'fixture';
    limits: PluginDaemonDatabaseLimits;
}>): void {
    if (Buffer.byteLength(params.sql, 'utf8') > params.limits.maximumInputBytes) {
        fail('daemon_database_input_too_large', 'SQLite statement input exceeds the daemon database limit');
    }
    const stripped = stripCommentsAndValidateTail(params.sql);
    const normalized = stripped.toUpperCase();
    const executableSource = normalized.trim().replace(/^EXPLAIN(?:\s+QUERY\s+PLAN)?\s+/u, '');
    const keyword = firstSqlKeyword(executableSource);
    const transactionControl = new Set([
        'BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE',
    ]);
    if (
        transactionControl.has(keyword)
        || keyword === 'ATTACH'
        || keyword === 'DETACH'
        || keyword === 'PRAGMA'
        || keyword === 'VACUUM'
    ) {
        fail('daemon_database_statement_forbidden', `SQLite ${keyword} is host-controlled`);
    }
    if (/\bCREATE\s+(?:TEMP|TEMPORARY|VIRTUAL)\b/u.test(normalized)
        || /\bLOAD_EXTENSION\s*\(/u.test(normalized)
        // SQLite accepts temp as a quoted schema identifier too. The existing
        // unquoted rule already rejects temp table aliases, so preserving that
        // containment boundary for quoted identifiers does not narrow an
        // otherwise-admitted statement form.
        || /(?:\bTEMP\b|["`]TEMP["`]|\[TEMP\])\s*\./u.test(normalized)) {
        fail('daemon_database_statement_forbidden', 'SQLite statement accesses an unsupported schema or module');
    }
    if (/\b_HAPPIER_PLUGIN_SCHEMA\b/u.test(normalized)
        || /\bSQLITE_(?:MASTER|SCHEMA|TEMP_MASTER|SEQUENCE|STAT[0-9]*)\b/u.test(normalized)) {
        fail('daemon_database_reserved_schema', 'SQLite host schema is not visible to plugins');
    }
    if (params.mode === 'fixture' && !isReadOnlyFixtureStatement(executableSource, keyword)) {
        fail('daemon_database_fixture_not_read_only', 'Incumbent query fixtures may execute only read-only SQLite statements');
    }
}

function cloneResultRows<TRow extends DatabaseRow>(
    rows: readonly unknown[],
): readonly TRow[] {
    const normalizedRows: TRow[] = [];
    for (const rawRow of rows) {
        if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
            fail('daemon_database_result_invalid', 'SQLite query returned an invalid row');
        }
        const row = Object.create(null) as Record<string, DatabaseValue>;
        for (const [key, value] of Object.entries(rawRow)) {
            assertDatabaseValue(value);
            row[key] = value instanceof Uint8Array ? new Uint8Array(value) : value;
        }
        normalizedRows.push(row as TRow);
    }
    return Object.freeze(normalizedRows);
}

function workerResultOptions(
    limits: PluginDaemonDatabaseLimits,
    options?: DaemonDatabaseWorkerRequestOptions,
): DaemonDatabaseWorkerAllRequestOptions {
    return Object.freeze({
        ...options,
        resultLimits: Object.freeze({
            maximumResultBytes: limits.maximumResultBytes,
            maximumResultRows: limits.maximumResultRows,
        }),
    });
}

async function runStatement(
    worker: DaemonDatabaseWorkerLease,
    sql: string,
    params: readonly DatabaseValue[],
    options?: DaemonDatabaseWorkerRequestOptions,
): Promise<SqliteRunResult> {
    return await worker.run(sql, params, options) as SqliteRunResult;
}

function normalizeExecutionResult(
    raw: SqliteRunResult,
    maximumAffectedRows: number,
): DatabaseExecutionResult {
    const changes = raw.changes;
    if (typeof changes !== 'number' || !Number.isSafeInteger(changes) || changes < 0) {
        fail('daemon_database_result_invalid', 'SQLite execution result did not include a valid change count');
    }
    if (changes > maximumAffectedRows) {
        fail('daemon_database_affected_rows_exceeded', 'SQLite statement exceeds the daemon database affected-row limit');
    }
    const lastInsertRowId = raw.lastInsertRowId ?? raw.lastInsertRowid;
    if (lastInsertRowId !== undefined && typeof lastInsertRowId !== 'number' && typeof lastInsertRowId !== 'bigint') {
        fail('daemon_database_result_invalid', 'SQLite execution result included an invalid insert row id');
    }
    return Object.freeze({
        changes,
        ...(lastInsertRowId === undefined ? {} : { lastInsertRowId }),
    });
}

async function readPragmaNumber(
    worker: DaemonDatabaseWorkerLease,
    sql: string,
    field: string,
    allowZero = false,
    options?: DaemonDatabaseWorkerRequestOptions,
): Promise<number> {
    const raw = await worker.get(sql, [], options);
    if (!raw || typeof raw !== 'object') {
        fail('daemon_database_host_policy_invalid', `SQLite did not return ${field}`);
    }
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
        fail('daemon_database_host_policy_invalid', `SQLite returned an invalid ${field}`);
    }
    return value;
}

async function assertDatabaseQuota(
    worker: DaemonDatabaseWorkerLease,
    limits: PluginDaemonDatabaseLimits,
    options?: DaemonDatabaseWorkerRequestOptions,
): Promise<number> {
    const pageSize = await readPragmaNumber(worker, 'PRAGMA page_size', 'page_size', false, options);
    const pageCount = await readPragmaNumber(worker, 'PRAGMA page_count', 'page_count', true, options);
    const pageBytes = pageSize * pageCount;
    if (pageBytes > limits.maximumDatabaseBytes) {
        fail('daemon_database_quota_exceeded', 'SQLite database exceeds the daemon database byte budget');
    }
    return pageBytes;
}

/**
 * The plugin-wide budget covers every database file the plugin retains on the
 * shared daemon disk, not only the handles this owner currently holds open.
 * Open entries contribute their live page accounting; every other retained
 * file — including one a superseded declaration set left behind — contributes
 * its on-disk size.
 */
function aggregatePluginDatabaseBytes(
    entries: Iterable<DatabaseEntry>,
    persistedFileBytes: ReadonlyMap<string, number>,
): number {
    let totalBytes = 0;
    const openFileNames = new Set<string>();
    for (const entry of entries) {
        totalBytes += entry.pageBytes;
        openFileNames.add(basename(entry.filePath));
    }
    for (const [fileName, fileBytes] of persistedFileBytes) {
        if (openFileNames.has(fileName)) continue;
        totalBytes += fileBytes;
    }
    return totalBytes;
}

async function configureHostDatabase(
    entry: DatabaseEntry,
    worker: DaemonDatabaseWorkerLease,
    limits: PluginDaemonDatabaseLimits,
    options?: DaemonDatabaseWorkerRequestOptions,
): Promise<void> {
    const pageSize = await readPragmaNumber(worker, 'PRAGMA page_size', 'page_size', false, options);
    const maximumPages = Math.floor(limits.maximumDatabaseBytes / pageSize);
    if (maximumPages < 1) {
        fail('daemon_database_limits_invalid', 'maximumDatabaseBytes is smaller than a SQLite page');
    }
    // This remains the per-file ceiling; the owner checks all open plugin
    // databases together before each transaction commits.
    await worker.exec('PRAGMA journal_mode=WAL', options);
    await worker.exec('PRAGMA synchronous=NORMAL', options);
    await worker.exec('PRAGMA foreign_keys=ON', options);
    await worker.exec(`PRAGMA max_page_count=${maximumPages}`, options);
    entry.pageBytes = await assertDatabaseQuota(worker, limits, options);
    entry.configuredWorkerSessionId = worker.sessionId;
}

async function acquireConfiguredWorker(
    entry: DatabaseEntry,
    limits: PluginDaemonDatabaseLimits,
    options?: DaemonDatabaseWorkerRequestOptions,
): Promise<DaemonDatabaseWorkerLease> {
    const worker = await entry.worker.acquire();
    if (entry.configuredWorkerSessionId !== worker.sessionId) {
        await configureHostDatabase(entry, worker, limits, options);
    }
    return worker;
}

function assertPluginDatabaseNamespace(pluginId: string): string {
    const parsed = PluginIdSchema.safeParse(pluginId);
    if (!parsed.success) {
        fail('daemon_database_identity_invalid', 'Daemon database requires a canonical plugin id');
    }
    const namespace = normalizePluginStorageNamespace(parsed.data);
    if (namespace !== parsed.data) {
        fail('daemon_database_identity_invalid', 'Daemon database requires an unambiguous plugin namespace');
    }
    return namespace;
}

async function ensurePluginDatabasesDirectory(params: Readonly<{
    namespace: string;
    paths: PluginStorePaths;
}>): Promise<string> {
    const namespace = params.namespace;
    await mkdir(params.paths.storageDir, { recursive: true });
    const storageRoot = await realpath(params.paths.storageDir);
    const pluginDirectory = resolve(storageRoot, namespace);
    if (relative(storageRoot, pluginDirectory) !== namespace) {
        fail('daemon_database_path_invalid', 'Plugin daemon database path escaped its storage namespace');
    }
    await mkdir(pluginDirectory, { recursive: false }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    const pluginMetadata = await lstat(pluginDirectory);
    if (!pluginMetadata.isDirectory() || pluginMetadata.isSymbolicLink()) {
        fail('daemon_database_path_invalid', 'Plugin daemon database namespace must be a real directory');
    }
    const pluginRealPath = await realpath(pluginDirectory);
    if (relative(storageRoot, pluginRealPath) !== namespace) {
        fail('daemon_database_path_invalid', 'Plugin daemon database namespace escaped its storage root');
    }
    const databasesDirectory = resolve(pluginRealPath, 'databases');
    if (relative(pluginRealPath, databasesDirectory) !== 'databases') {
        fail('daemon_database_path_invalid', 'Plugin daemon database directory escaped its namespace');
    }
    await mkdir(databasesDirectory, { recursive: false }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    const databasesMetadata = await lstat(databasesDirectory);
    if (!databasesMetadata.isDirectory() || databasesMetadata.isSymbolicLink()) {
        fail('daemon_database_path_invalid', 'Plugin daemon database directory must be a real directory');
    }
    const databasesRealPath = await realpath(databasesDirectory);
    if (relative(pluginRealPath, databasesRealPath) !== 'databases') {
        fail('daemon_database_path_invalid', 'Plugin daemon database directory escaped its namespace');
    }
    return databasesRealPath;
}

function pluginDatabaseFileName(localId: string): string {
    return `${encodeURIComponent(localId)}${DATABASE_FILE_SUFFIX}`;
}

/**
 * Every database file the plugin retains in its own storage namespace, by file
 * name. Undeclared files a superseded declaration set left behind are included
 * because the byte budget is plugin-wide and the daemon disk is shared. WAL and
 * shared-memory sidecars are excluded so the census keeps the same page-image
 * basis as the live `PRAGMA page_count` accounting it is combined with.
 */
async function readPersistedPluginDatabaseFileBytes(params: Readonly<{
    pluginId: string;
    paths: PluginStorePaths;
}>): Promise<ReadonlyMap<string, number>> {
    const namespace = assertPluginDatabaseNamespace(params.pluginId);
    const directory = await ensurePluginDatabasesDirectory({ namespace, paths: params.paths });
    const fileBytes = new Map<string, number>();
    for (const fileName of await readdir(directory)) {
        if (!fileName.endsWith(DATABASE_FILE_SUFFIX)) continue;
        const metadata = await lstat(resolve(directory, fileName)).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        });
        // A symlink is never a database this owner can open, and its own inode
        // holds only a path, so it contributes nothing measurable here.
        if (!metadata || !metadata.isFile() || metadata.isSymbolicLink()) continue;
        fileBytes.set(fileName, metadata.size);
    }
    return fileBytes;
}

async function ensurePluginDatabasePath(params: Readonly<{
    pluginId: string;
    paths: PluginStorePaths;
    localId: string;
}>): Promise<string> {
    const namespace = assertPluginDatabaseNamespace(params.pluginId);
    const localId = assertDatabaseLocalId(params.localId);
    const databasesRealPath = await ensurePluginDatabasesDirectory({ namespace, paths: params.paths });
    const fileName = pluginDatabaseFileName(localId);
    const filePath = resolve(databasesRealPath, fileName);
    if (relative(databasesRealPath, filePath) !== fileName || filePath.includes(`..${sep}`)) {
        fail('daemon_database_path_invalid', 'Plugin daemon database file escaped its namespace');
    }
    try {
        const metadata = await lstat(filePath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
            fail('daemon_database_path_invalid', 'Plugin daemon database file must be a regular non-symlink file');
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return filePath;
}

async function hasLedger(worker: DaemonDatabaseWorkerLease): Promise<boolean> {
    const row = await worker.get(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        [LEDGER_TABLE],
    );
    return Boolean(row);
}

async function readLedger(worker: DaemonDatabaseWorkerLease): Promise<readonly Readonly<{ version: number; id: string }>[]> {
    if (!await hasLedger(worker)) return Object.freeze([]);
    const ledger: Array<Readonly<{ version: number; id: string }>> = [];
    let previousVersion = 0;
    const ids = new Set<string>();
    while (true) {
        // Ledger records are fixed host schema, not plugin query output. Read
        // one record at a time through the existing single-row IPC operation so
        // public result caps neither become a migration compatibility limit nor
        // leave an unbounded worker `all()` bypass.
        const row = await worker.get(
            `SELECT version, id FROM ${LEDGER_TABLE} WHERE version > ? ORDER BY version ASC LIMIT 1`,
            [previousVersion],
        );
        if (row === undefined) break;
        if (!row || typeof row !== 'object') {
            fail('daemon_database_ledger_invalid', 'SQLite migration ledger contains an invalid row');
        }
        const version = (row as Record<string, unknown>).version;
        const id = (row as Record<string, unknown>).id;
        if (typeof version !== 'number' || !Number.isSafeInteger(version) || version <= previousVersion || typeof id !== 'string' || !id || ids.has(id)) {
            fail('daemon_database_ledger_invalid', 'SQLite migration ledger identities are invalid');
        }
        ids.add(id);
        previousVersion = version;
        ledger.push(Object.freeze({ version, id }));
    }
    return Object.freeze(ledger);
}

async function hasApplicationTables(worker: DaemonDatabaseWorkerLease): Promise<boolean> {
    const row = await worker.get(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != ? LIMIT 1",
        [LEDGER_TABLE],
    );
    return Boolean(row);
}

async function ensureLedger(
    worker: DaemonDatabaseWorkerLease,
    options?: DaemonDatabaseWorkerRequestOptions,
): Promise<void> {
    await worker.exec(
        `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (`
        + 'version INTEGER PRIMARY KEY CHECK (version > 0), '
        + 'id TEXT NOT NULL UNIQUE'
        + ')',
        options,
    );
}

function verifyLedgerPrefix(params: Readonly<{
    ledger: readonly Readonly<{ version: number; id: string }>[];
    declaration: PluginDaemonDatabaseContributionV1;
}>): void {
    if (params.ledger.length > params.declaration.migrations.length) {
        fail('daemon_database_declaration_mismatch', 'SQLite migration ledger is newer than the declared runtime contract');
    }
    for (const [index, row] of params.ledger.entries()) {
        const expected = params.declaration.migrations[index];
        if (!expected || expected.version !== row.version || expected.id !== row.id) {
            fail('daemon_database_declaration_mismatch', 'SQLite migration ledger does not match declared migration identities');
        }
    }
}

function validateRuntimeContract(params: Readonly<{
    localId: string;
    declarations: readonly PluginDaemonDatabaseContributionV1[];
    options: NormalizedDatabaseOpenOptions;
}>): PluginDaemonDatabaseContributionV1 {
    const declarations = params.declarations.filter((declaration) => declaration.id === params.localId);
    if (declarations.length !== 1) {
        fail('daemon_database_declaration_mismatch', 'Daemon database must have exactly one static declaration');
    }
    const declaration = declarations[0]!;
    assertMigrationSequence(params.options.migrations, 'Runtime daemon database');
    if (declaration.incumbentQueryFixtureId !== assertRuntimeIdentity(
        params.options.incumbentQueryFixture.id,
        'Runtime incumbent query fixture id',
    )) {
        fail('daemon_database_declaration_mismatch', 'Runtime incumbent query fixture does not match the declaration');
    }
    if (declaration.migrations.length !== params.options.migrations.length) {
        fail('daemon_database_declaration_mismatch', 'Runtime migration count does not match the declaration');
    }
    for (const [index, declared] of declaration.migrations.entries()) {
        const runtime = params.options.migrations[index];
        if (!runtime || runtime.version !== declared.version || runtime.id !== declared.id || typeof runtime.up !== 'function') {
            fail('daemon_database_declaration_mismatch', 'Runtime migrations must exactly match the declaration');
        }
    }
    if (typeof params.options.incumbentQueryFixture.run !== 'function') {
        fail('daemon_database_declaration_mismatch', 'Runtime incumbent query fixture must be executable');
    }
    return declaration;
}

function isExactPreparedIncumbentContract(
    value: unknown,
    localId: string,
): value is PreparedDatabaseContract {
    if (!value || typeof value !== 'object') return false;
    const contract = value as Partial<PreparedDatabaseContract>;
    const fixture = contract.incumbentQueryFixture;
    return contract.id === localId
        && typeof contract.incumbentQueryFixtureId === 'string'
        && PluginContributionLocalIdSchema.safeParse(contract.incumbentQueryFixtureId).success
        && Boolean(fixture)
        && typeof fixture?.id === 'string'
        && fixture.id === contract.incumbentQueryFixtureId
        && typeof fixture.run === 'function';
}

type HostTransactionContext = Readonly<{
    worker: DaemonDatabaseWorkerLease;
    requestOptionsFor(operationSignal?: AbortSignal): DaemonDatabaseWorkerRequestOptions;
    assertUsable(operationSignal?: AbortSignal): void;
}>;

function createTransactionDeadline(params: Readonly<{
    limits: PluginDaemonDatabaseLimits;
    signal: AbortSignal;
    isGenerationCurrent: () => boolean;
    operationSignal?: AbortSignal;
}>): Readonly<{
    context: Pick<HostTransactionContext, 'requestOptionsFor' | 'assertUsable'>;
    beginCommit(): void;
    dispose(): void;
}> {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), params.limits.maximumElapsedMs);
    timer.unref?.();
    const baseSignal = AbortSignal.any([
        params.signal,
        timeoutController.signal,
        ...(params.operationSignal ? [params.operationSignal] : []),
    ]);
    const createAbortError = (): Error => {
        // Both outcomes are transient: the statement was abandoned, not
        // rejected, so the same operation can be issued again.
        if (timeoutController.signal.aborted) {
            return new PluginContextServiceError(
                'daemon_database_timeout',
                'SQLite operation exceeded the daemon database elapsed-time limit',
                true,
            );
        }
        return new PluginContextServiceError(
            'daemon_database_cancelled',
            'Plugin daemon database operation was cancelled',
            true,
        );
    };
    const assertUsable = (operationSignal?: AbortSignal): void => {
        if (timeoutController.signal.aborted) throw createAbortError();
        assertCurrent({
            signal: params.signal,
            isGenerationCurrent: params.isGenerationCurrent,
            ...(params.operationSignal ? { operationSignal: params.operationSignal } : {}),
        });
        if (operationSignal?.aborted) throw createAbortError();
    };
    return Object.freeze({
        context: Object.freeze({
            requestOptionsFor: (operationSignal?: AbortSignal): DaemonDatabaseWorkerRequestOptions => Object.freeze({
                signal: operationSignal ? AbortSignal.any([baseSignal, operationSignal]) : baseSignal,
                createAbortError,
            }),
            assertUsable,
        }),
        // Once the host admits the short final COMMIT, cancellation races report
        // the observed commit result instead of claiming an unobservable rollback.
        beginCommit: () => clearTimeout(timer),
        dispose: () => clearTimeout(timer),
    });
}

async function withHostTransaction<T>(params: Readonly<{
    entry: DatabaseEntry;
    limits: PluginDaemonDatabaseLimits;
    readAggregateBytes: () => Promise<number>;
    assertQuota: (baselineBytes: number) => Promise<void>;
    signal: AbortSignal;
    isGenerationCurrent: () => boolean;
    operationSignal?: AbortSignal;
    operation: (context: HostTransactionContext) => Promise<T>;
}>): Promise<T> {
    const deadline = createTransactionDeadline(params);
    const worker = await acquireConfiguredWorker(
        params.entry,
        params.limits,
        deadline.context.requestOptionsFor(),
    );
    const context: HostTransactionContext = Object.freeze({
        worker,
        ...deadline.context,
    });
    let began = false;
    let committed = false;
    try {
        context.assertUsable();
        await worker.exec('BEGIN IMMEDIATE', context.requestOptionsFor());
        began = true;
        // A plugin already over its plugin-wide budget must still be able to
        // read and shrink, so the commit gate refuses growth rather than the
        // pre-existing size it inherited.
        const baselineBytes = await params.readAggregateBytes();
        context.assertUsable();
        const result = await params.operation(context);
        context.assertUsable();
        params.entry.pageBytes = await assertDatabaseQuota(
            worker,
            params.limits,
            context.requestOptionsFor(),
        );
        await params.assertQuota(baselineBytes);
        deadline.beginCommit();
        await worker.exec('COMMIT');
        committed = true;
        return result;
    } catch (error) {
        if (began && !committed && !worker.isRetired()) {
            try {
                await worker.exec('ROLLBACK');
                params.entry.pageBytes = await assertDatabaseQuota(worker, params.limits);
            } catch {
                // The original transaction failure is the actionable result.
            }
        }
        throw error;
    } finally {
        deadline.dispose();
    }
}

function queueEntry<T>(params: Readonly<{
    entry: DatabaseEntry;
    ownerSignal: AbortSignal;
    isGenerationCurrent: () => boolean;
    assertOwnerUsable?: () => void;
    operationSignal?: AbortSignal;
    operation: () => Promise<T>;
}>): Promise<T> {
    params.assertOwnerUsable?.();
    assertCurrent({
        signal: params.ownerSignal,
        isGenerationCurrent: params.isGenerationCurrent,
        ...(params.operationSignal ? { operationSignal: params.operationSignal } : {}),
    });
    if (params.entry.closed) {
        return Promise.reject(new PluginContextServiceError(
            'daemon_database_closed',
            'Plugin daemon database handle is closed',
        ));
    }
    const preceding = params.entry.tail;
    let release!: () => void;
    params.entry.tail = new Promise<void>((resolveRelease) => {
        release = resolveRelease;
    });
    return (async () => {
        try {
            await preceding;
            params.assertOwnerUsable?.();
            assertCurrent({
                signal: params.ownerSignal,
                isGenerationCurrent: params.isGenerationCurrent,
                ...(params.operationSignal ? { operationSignal: params.operationSignal } : {}),
            });
            if (params.entry.closed) {
                fail('daemon_database_closed', 'Plugin daemon database handle is closed');
            }
            return await params.operation();
        } finally {
            release();
        }
    })();
}

function createTransactionHandle(params: Readonly<{
    entry: DatabaseEntry;
    limits: PluginDaemonDatabaseLimits;
    worker: DaemonDatabaseWorkerLease;
    requestOptionsFor(operationSignal?: AbortSignal): DaemonDatabaseWorkerRequestOptions;
    assertHostTransactionUsable(operationSignal?: AbortSignal): void;
    mode: 'ordinary' | 'migration' | 'fixture';
}>): ActiveDatabaseTransaction {
    let active = true;
    const assertUsable = (operationSignal?: AbortSignal): void => {
        if (!active || params.entry.closed) {
            fail('daemon_database_transaction_ended', 'Plugin daemon database transaction is no longer active');
        }
        params.assertHostTransactionUsable(operationSignal);
    };
    const query = async <TRow extends DatabaseRow = DatabaseRow>(
        sql: string,
        values: readonly DatabaseValue[] = [],
        options?: DatabaseCancellation,
    ): Promise<readonly TRow[]> => {
        assertUsable(options?.signal);
        assertClassifiedPluginStatement({ sql, mode: params.mode, limits: params.limits });
        assertParameters(values, params.limits.maximumInputBytes, sql);
        const rows = await params.worker.all(
            sql,
            values,
            workerResultOptions(params.limits, params.requestOptionsFor(options?.signal)),
        );
        assertUsable(options?.signal);
        return cloneResultRows<TRow>(rows);
    };
    const execute = async (
        sql: string,
        values: readonly DatabaseValue[] = [],
        options?: DatabaseCancellation,
    ): Promise<DatabaseExecutionResult> => {
        if (params.mode === 'fixture') {
            fail('daemon_database_fixture_not_read_only', 'Incumbent query fixtures cannot execute SQLite mutations');
        }
        assertUsable(options?.signal);
        assertClassifiedPluginStatement({ sql, mode: params.mode, limits: params.limits });
        assertParameters(values, params.limits.maximumInputBytes, sql);
        const result = normalizeExecutionResult(
            await runStatement(params.worker, sql, values, params.requestOptionsFor(options?.signal)),
            params.limits.maximumAffectedRows,
        );
        params.entry.pageBytes = await assertDatabaseQuota(
            params.worker,
            params.limits,
            params.requestOptionsFor(options?.signal),
        );
        assertUsable(options?.signal);
        return result;
    };
    const handle = Object.freeze({ query, execute });
    return Object.freeze({
        ...handle,
        end: () => { active = false; },
    });
}

function createPublicDatabaseHandle(params: Readonly<{
    entry: DatabaseEntry;
    limits: PluginDaemonDatabaseLimits;
    readAggregateBytes: () => Promise<number>;
    assertQuota: (baselineBytes: number) => Promise<void>;
    ownerSignal: AbortSignal;
    isGenerationCurrent: () => boolean;
    assertOwnerUsable?: () => void;
}>): DatabaseHandle {
    const assertNoReentrantCall = (): void => {
        if (databaseOperationContext.getStore()?.has(params.entry)) {
            fail('daemon_database_transaction_reentry', 'Use the active daemon database transaction handle');
        }
    };
    const executeExclusive = async <T>(
        operation: (transaction: DatabaseTransaction) => Promise<T>,
        options?: DatabaseCancellation,
    ): Promise<T> => {
        params.assertOwnerUsable?.();
        assertNoReentrantCall();
        return await queueEntry({
            entry: params.entry,
            ownerSignal: params.ownerSignal,
            isGenerationCurrent: params.isGenerationCurrent,
            ...(params.assertOwnerUsable ? { assertOwnerUsable: params.assertOwnerUsable } : {}),
            ...(options?.signal ? { operationSignal: options.signal } : {}),
            operation: async () => await withHostTransaction({
                entry: params.entry,
                limits: params.limits,
                readAggregateBytes: params.readAggregateBytes,
                assertQuota: params.assertQuota,
                signal: params.ownerSignal,
                isGenerationCurrent: params.isGenerationCurrent,
                ...(options?.signal ? { operationSignal: options.signal } : {}),
                operation: async (context) => {
                    const transaction = createTransactionHandle({
                        entry: params.entry,
                        limits: params.limits,
                        worker: context.worker,
                        requestOptionsFor: context.requestOptionsFor,
                        assertHostTransactionUsable: context.assertUsable,
                        mode: 'ordinary',
                    }) as DatabaseTransaction & Readonly<{ end: () => void }>;
                    try {
                        return await databaseOperationContext.run(
                            new Set([params.entry]),
                            async () => await operation(transaction),
                        );
                    } finally {
                        transaction.end();
                    }
                },
            }),
        });
    };
    return Object.freeze({
        query: async <TRow extends DatabaseRow = DatabaseRow>(
            sql: string,
            values: readonly DatabaseValue[] = [],
            options?: DatabaseCancellation,
        ): Promise<readonly TRow[]> => await executeExclusive(
            async (transaction) => await transaction.query<TRow>(sql, values, options),
            options,
        ),
        execute: async (
            sql: string,
            values: readonly DatabaseValue[] = [],
            options?: DatabaseCancellation,
        ): Promise<DatabaseExecutionResult> => await executeExclusive(
            async (transaction) => await transaction.execute(sql, values, options),
            options,
        ),
        transaction: async <T>(
            operation: (transaction: DatabaseTransaction) => Promise<T>,
            options?: DatabaseCancellation,
        ): Promise<T> => await executeExclusive(operation, options),
    });
}

/**
 * The daemon-local database producer. Its declaration input is deliberately
 * private until the canonical manifest projection hands it normalized facts;
 * it owns no manifest registry or candidate-currentness fact of its own.
 */
export function createPluginDaemonDatabaseOwner(params: Readonly<{
    pluginId: string;
    paths: PluginStorePaths;
    signal: AbortSignal;
    isGenerationCurrent: () => boolean;
    limits: PluginDaemonDatabaseLimits;
    declarations: readonly PluginDaemonDatabaseContributionV1[];
    /** Exact adopted prior-generation fixtures, keyed by declared database id. */
    incumbentContracts?: ReadonlyMap<string, PreparedDatabaseContract>;
}>): PluginDaemonDatabaseOwner {
    const limits = validateLimits(params.limits);
    const declarations = Object.freeze(params.declarations.map((declaration) => (
        PluginDaemonDatabaseContributionV1Schema.parse(declaration)
    )));
    const entries = new Map<string, DatabaseEntry>();
    /**
     * On-disk sizes of the plugin's retained database files. The set of open
     * entries is applied at use time, so this stays valid until the files
     * themselves can have changed behind this owner: an entry closing, or a
     * candidate writing them while this owner is quiesced.
     */
    let persistedFileBytes: ReadonlyMap<string, number> | null = null;
    const invalidatePersistedCensus = (): void => {
        persistedFileBytes = null;
    };
    const readAggregateBytes = async (): Promise<number> => {
        persistedFileBytes ??= await readPersistedPluginDatabaseFileBytes({
            pluginId: params.pluginId,
            paths: params.paths,
        });
        return aggregatePluginDatabaseBytes(entries.values(), persistedFileBytes);
    };
    const assertQuota = async (baselineBytes: number): Promise<void> => {
        const totalBytes = await readAggregateBytes();
        if (totalBytes <= limits.maximumDatabaseBytes || totalBytes <= baselineBytes) return;
        fail('daemon_database_quota_exceeded', 'Plugin daemon databases exceed the aggregate byte budget');
    };
    /**
     * `ensurePluginDatabasePath` is asynchronous. Publish one pending open
     * before awaiting it so concurrent callers cannot each create a native
     * SQLite connection for the same logical database.
     */
    const openingEntries = new Map<string, Promise<DatabaseEntry>>();
    const preparedContracts = new Map<string, PreparedDatabaseContract>();
    let ownerClosed = false;
    let ownerQuiesced = false;
    let closePromise: Promise<void> | null = null;

    const assertOwnerUsable = (operationSignal?: AbortSignal): void => {
        if (ownerClosed) fail('daemon_database_closed', 'Plugin daemon database owner is closed');
        if (ownerQuiesced) {
            fail(
                'daemon_database_quiesced',
                'Plugin daemon database is temporarily quiesced for candidate preparation',
            );
        }
        assertCurrent({
            signal: params.signal,
            isGenerationCurrent: params.isGenerationCurrent,
            ...(operationSignal ? { operationSignal } : {}),
        });
    };

    const createEntry = async (localId: string): Promise<DatabaseEntry> => {
        const filePath = await ensurePluginDatabasePath({
            pluginId: params.pluginId,
            paths: params.paths,
            localId,
        });
        const entry: DatabaseEntry = {
            localId,
            filePath,
            worker: createDaemonDatabaseWorkerClient(filePath),
            tail: Promise.resolve(),
            initialized: null,
            pageBytes: 0,
            configuredWorkerSessionId: null,
            closed: false,
        };
        try {
            await acquireConfiguredWorker(entry, limits);
            return entry;
        } catch (error) {
            await entry.worker.close().catch(() => undefined);
            throw error;
        }
    };

    const readOrOpenEntry = (localId: string): Promise<DatabaseEntry> => {
        const existing = entries.get(localId);
        if (existing) return Promise.resolve(existing);

        const opening = openingEntries.get(localId);
        if (opening) return opening;

        // Opening is not growth: a retained file already counted against the
        // budget from disk, and refusing the handle would strand the very data
        // the plugin has to read and shrink. The commit gate owns the refusal.
        const created = createEntry(localId).then((entry) => {
            entries.set(localId, entry);
            invalidatePersistedCensus();
            return entry;
        });
        openingEntries.set(localId, created);
        const clearOpening = (): void => {
            if (openingEntries.get(localId) === created) {
                openingEntries.delete(localId);
            }
        };
        void created.then(clearOpening, clearOpening);
        return created;
    };

    const prepareEntry = async (
        entry: DatabaseEntry,
        options: NormalizedDatabaseOpenOptions,
        declaration: PluginDaemonDatabaseContributionV1,
    ): Promise<void> => {
        const initialWorker = await acquireConfiguredWorker(entry, limits);
        const ledger = await readLedger(initialWorker);
        verifyLedgerPrefix({ ledger, declaration });
        const pending = options.migrations.slice(ledger.length);
        if (pending.length === 0) {
            preparedContracts.set(entry.localId, Object.freeze({
                id: entry.localId,
                incumbentQueryFixtureId: options.incumbentQueryFixture.id,
                incumbentQueryFixture: options.incumbentQueryFixture,
            }));
            return;
        }
        const incumbentContract = params.incumbentContracts?.get(entry.localId);
        if (
            (ledger.length > 0 || await hasApplicationTables(initialWorker))
            && !isExactPreparedIncumbentContract(incumbentContract, entry.localId)
        ) {
            fail(
                'daemon_database_migration_requires_future_contract',
                'A retained daemon database migration requires the exact prior-generation query fixture',
            );
        }
        const incumbentFixture = incumbentContract?.incumbentQueryFixture;
        await queueEntry({
            entry,
            ownerSignal: params.signal,
            isGenerationCurrent: params.isGenerationCurrent,
            assertOwnerUsable: () => assertOwnerUsable(options.signal),
            ...(options.signal ? { operationSignal: options.signal } : {}),
            operation: async () => await withHostTransaction({
                entry,
                limits,
                readAggregateBytes,
                assertQuota,
                signal: params.signal,
                isGenerationCurrent: params.isGenerationCurrent,
                ...(options.signal ? { operationSignal: options.signal } : {}),
                operation: async (context) => {
                    await ensureLedger(context.worker, context.requestOptionsFor());
                    const migrationTransaction = createTransactionHandle({
                        entry,
                        limits,
                        worker: context.worker,
                        requestOptionsFor: context.requestOptionsFor,
                        assertHostTransactionUsable: context.assertUsable,
                        mode: 'migration',
                    });
                    try {
                        await databaseOperationContext.run(new Set([entry]), async () => {
                            for (const migration of pending) {
                                await migration.up(migrationTransaction);
                                assertOwnerUsable(options.signal);
                                await runStatement(
                                    context.worker,
                                    `INSERT INTO ${LEDGER_TABLE} (version, id) VALUES (?, ?)`,
                                    [migration.version, migration.id],
                                    context.requestOptionsFor(),
                                );
                                entry.pageBytes = await assertDatabaseQuota(
                                    context.worker,
                                    limits,
                                    context.requestOptionsFor(),
                                );
                            }
                        });
                    } catch (error) {
                        if (error instanceof PluginContextServiceError) throw error;
                        throw new PluginContextServiceError(
                            'daemon_database_migration_failed',
                            error instanceof Error ? error.message : 'Daemon database migration failed',
                        );
                    } finally {
                        migrationTransaction.end();
                    }
                    if (incumbentFixture) {
                        const fixtureTransaction = createTransactionHandle({
                            entry,
                            limits,
                            worker: context.worker,
                            requestOptionsFor: context.requestOptionsFor,
                            assertHostTransactionUsable: context.assertUsable,
                            mode: 'fixture',
                        });
                        try {
                            await databaseOperationContext.run(new Set([entry]), async () => {
                                await incumbentFixture.run(fixtureTransaction);
                            });
                        } catch (error) {
                            if (
                                error instanceof PluginContextServiceError
                                && (
                                    error.code === 'plugin_generation_stale'
                                    || error.code === 'daemon_database_cancelled'
                                    || error.code === 'daemon_database_timeout'
                                )
                            ) {
                                throw error;
                            }
                            throw new PluginContextServiceError(
                                'daemon_database_migration_requires_future_contract',
                                error instanceof Error
                                    ? error.message
                                    : 'The prior-generation daemon database query fixture failed',
                            );
                        } finally {
                            fixtureTransaction.end();
                        }
                    }
                },
            }),
        });
        preparedContracts.set(entry.localId, Object.freeze({
            id: entry.localId,
            incumbentQueryFixtureId: options.incumbentQueryFixture.id,
            incumbentQueryFixture: options.incumbentQueryFixture,
        }));
    };

    const storage: DatabaseStorageScope = Object.freeze({
        database: async (name: string, options: DatabaseOpenOptions): Promise<DaemonDatabase> => {
            assertOwnerUsable(options.signal);
            const localId = assertDatabaseLocalId(name);
            const normalizedOptions = normalizeDatabaseOpenOptions(options);
            // Validate every call, including calls that reuse a prepared handle:
            // one static declaration must retain exactly one runtime meaning.
            const declaration = validateRuntimeContract({
                localId,
                declarations,
                options: normalizedOptions,
            });
            const entry = await readOrOpenEntry(localId);
            assertOwnerUsable(options.signal);
            if (!entry.initialized) {
                entry.initialized = prepareEntry(entry, normalizedOptions, declaration).catch(async (error) => {
                    if (entries.get(localId) === entry) {
                        entries.delete(localId);
                        invalidatePersistedCensus();
                    }
                    entry!.closed = true;
                    await entry!.worker.close().catch(() => undefined);
                    throw error;
                });
            }
            await entry.initialized;
            assertOwnerUsable(options.signal);
            return createPublicDatabaseHandle({
                entry,
                limits,
                readAggregateBytes,
                assertQuota,
                ownerSignal: params.signal,
                isGenerationCurrent: params.isGenerationCurrent,
                assertOwnerUsable: () => assertOwnerUsable(),
            });
        },
    });

    const closeOpenEntries = async (): Promise<void> => {
        // A caller may already be awaiting path validation when quiescence or
        // retirement starts. Wait for that one shared open before selecting
        // entries to close, otherwise the connection could be published after
        // the close pass and remain an OS-level handle leak.
        await Promise.allSettled([...openingEntries.values()]);
        const entriesToClose = [...entries.values()];
        await Promise.all(entriesToClose.map(async (entry) => await entry.tail));
        for (const entry of entriesToClose) {
            if (entry.closed) continue;
            entry.closed = true;
            await entry.worker.close();
        }
        entries.clear();
        invalidatePersistedCensus();
    };

    return Object.freeze({
        storage,
        readPreparedContracts: () => Object.freeze([...preparedContracts.values()].sort((left, right) => (
            left.id.localeCompare(right.id)
        ))),
        quiesce: async (): Promise<PluginDaemonDatabaseQuiescence> => {
            if (ownerClosed) fail('daemon_database_closed', 'Plugin daemon database owner is closed');
            if (ownerQuiesced) {
                fail('daemon_database_quiesced', 'Plugin daemon database owner is already quiesced');
            }
            ownerQuiesced = true;
            await closeOpenEntries();
            let resumed = false;
            return Object.freeze({
                async resume(): Promise<void> {
                    if (resumed) return;
                    resumed = true;
                    // A candidate owned these files while this owner was
                    // quiesced, so the census taken before that is stale.
                    invalidatePersistedCensus();
                    if (!ownerClosed) ownerQuiesced = false;
                },
            });
        },
        close: async () => {
            if (closePromise) return await closePromise;
            ownerClosed = true;
            closePromise = (async () => {
                await closeOpenEntries();
                preparedContracts.clear();
            })();
            return await closePromise;
        },
    });
}

/**
 * Host configuration is injected rather than defaulted: the plan reserves
 * numeric policy for the measured Background Indexer evidence. The protocol
 * ceiling prevents an individual plugin resolver from manufacturing a larger
 * private allocation once that policy is supplied.
 */
export type PluginDaemonDatabaseLimitsPolicy = Readonly<{
    protocolMaximumDatabaseBytes: number;
    resolvePluginLimits(pluginId: string): PluginDaemonDatabaseLimits | null;
}>;

/**
 * Candidate-local executable callbacks, keyed by their already-normalized
 * manifest declaration. This is not a second registry: lifecycle activation
 * produces it from the named module export and this owner consumes it once.
 */
export type PluginDaemonDatabaseRuntimeProjection = SdkPluginDaemonDatabaseRuntimeProjection;

export type PluginDaemonDatabaseCapability = Readonly<
    | {
        status: 'available';
        protocolMaximumDatabaseBytes: number;
        limits: PluginDaemonDatabaseLimits;
    }
    | {
        status: 'unavailable';
        code: 'daemon_database_policy_unavailable' | 'daemon_database_unavailable';
    }
>;

export type StablePluginDaemonDatabaseHost = Readonly<{
    /**
     * Candidate bootstrap performs migration/fixture proof before it exposes
     * any generation-owned owner through invocation storage.
     */
    prepare(input: Readonly<{
        pluginId: string;
        generation: string;
        signal: AbortSignal;
        isGenerationCurrent(): boolean;
        declarations: readonly PluginDaemonDatabaseContributionV1[];
        runtime: PluginDaemonDatabaseRuntimeProjection;
        incumbentContracts?: readonly PluginDaemonDatabasePreparedContract[];
    }>): Promise<void>;
    /** Binds the one prepared owner to an individual invocation lifetime. */
    bind(input: Readonly<{
        pluginId: string;
        generation: string;
        signal: AbortSignal;
        isGenerationCurrent(): boolean;
    }>): DaemonDatabaseService;
    /** Exact adopted fixture callbacks available to a successor candidate. */
    readPreparedContracts(pluginId: string): readonly PluginDaemonDatabasePreparedContract[];
    /** Stops only selected incumbent handles while a candidate proves its fixture. */
    quiesce(pluginIds: readonly string[]): Promise<PluginDaemonDatabaseQuiescence>;
    /** The supplied measured policy is visible without leaking a driver. */
    readCapability(pluginId: string): PluginDaemonDatabaseCapability;
    /** Registry retirement owns the single close path for every database. */
    close(): Promise<void>;
}>;

type PreparedPluginDaemonDatabaseOwner = Readonly<{
    generation: string;
    limits: PluginDaemonDatabaseLimits;
    owner: PluginDaemonDatabaseOwner;
}>;

type QuiescedPluginDaemonDatabaseOwner = {
    references: number;
    quiescence: PluginDaemonDatabaseQuiescence;
};

type NormalizedRuntimeDatabase = Readonly<{
    declaration: PluginDaemonDatabaseContributionV1;
    options: DatabaseOpenOptions;
}>;

function isNonArrayRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDaemonDatabaseDeclarations(
    declarations: readonly PluginDaemonDatabaseContributionV1[],
): readonly PluginDaemonDatabaseContributionV1[] {
    const normalized = declarations.map((declaration) => (
        PluginDaemonDatabaseContributionV1Schema.parse(declaration)
    ));
    const declarationIds = new Set<string>();
    for (const declaration of normalized) {
        if (declarationIds.has(declaration.id)) {
            fail('daemon_database_declaration_mismatch', 'Daemon database declarations must have unique local ids');
        }
        declarationIds.add(declaration.id);
    }
    return Object.freeze(normalized);
}

function normalizeRuntimeProjection(params: Readonly<{
    declarations: readonly PluginDaemonDatabaseContributionV1[];
    runtime: PluginDaemonDatabaseRuntimeProjection;
}>): readonly NormalizedRuntimeDatabase[] {
    const declarations = normalizeDaemonDatabaseDeclarations(params.declarations);
    const declarationIds = new Set(declarations.map((declaration) => declaration.id));
    if (!isNonArrayRecord(params.runtime)) {
        fail('daemon_database_declaration_mismatch', 'Daemon database runtime callbacks must be a record');
    }
    const runtimeIds = Object.keys(params.runtime);
    if (
        runtimeIds.length !== declarationIds.size
        || runtimeIds.some((localId) => !declarationIds.has(localId))
    ) {
        fail('daemon_database_declaration_mismatch', 'Daemon database runtime callbacks must match declarations exactly');
    }
    return Object.freeze([...declarations]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((declaration) => {
            const runtime = params.runtime[declaration.id];
            if (!isNonArrayRecord(runtime) || !Array.isArray(runtime.migrations)) {
                fail('daemon_database_declaration_mismatch', 'Daemon database runtime callbacks are malformed');
            }
            const fixture = runtime.incumbentQueryFixture;
            if (!isNonArrayRecord(fixture) || typeof fixture.id !== 'string' || typeof fixture.run !== 'function') {
                fail('daemon_database_declaration_mismatch', 'Daemon database incumbent query fixture is malformed');
            }
            if (!runtime.migrations.every((migration) => (
                isNonArrayRecord(migration)
                && typeof migration.version === 'number'
                && typeof migration.id === 'string'
                && typeof migration.up === 'function'
            ))) {
                fail('daemon_database_declaration_mismatch', 'Daemon database migrations are malformed');
            }
            const options: DatabaseOpenOptions = Object.freeze({
                migrations: Object.freeze([...runtime.migrations]) as readonly DatabaseMigration[],
                incumbentQueryFixture: Object.freeze({
                    id: fixture.id,
                    run: fixture.run as DatabaseIncumbentQueryFixture['run'],
                }),
            });
            validateRuntimeContract({
                localId: declaration.id,
                declarations,
                options: normalizeDatabaseOpenOptions(options),
            });
            return Object.freeze({ declaration, options });
        }));
}

export function createUnavailablePluginDaemonDatabaseService(
    code: 'daemon_database_policy_unavailable' | 'daemon_database_unavailable',
): DaemonDatabaseService {
    return Object.freeze({
        async database(): Promise<never> {
            fail(
                code,
                code === 'daemon_database_policy_unavailable'
                    ? 'Plugin daemon databases are unavailable until measured host limits are configured'
                    : 'Plugin daemon database is unavailable for this invocation generation',
            );
        },
    });
}

function composeDatabaseOperationSignal(
    lifetimeSignal: AbortSignal,
    operationSignal: AbortSignal | undefined,
): AbortSignal {
    if (!operationSignal || operationSignal === lifetimeSignal) return lifetimeSignal;
    return AbortSignal.any([lifetimeSignal, operationSignal]);
}

function assertBoundDatabaseCurrent(params: Readonly<{
    signal: AbortSignal;
    isGenerationCurrent(): boolean;
}>): void {
    if (params.signal.aborted) {
        fail('daemon_database_cancelled', 'Plugin daemon database invocation was cancelled');
    }
    if (!params.isGenerationCurrent()) {
        fail('plugin_generation_stale', 'Plugin daemon database invocation generation is stale');
    }
}

function bindDatabaseTransaction(
    transaction: DatabaseTransaction,
    binding: Readonly<{ signal: AbortSignal; isGenerationCurrent(): boolean }>,
): DatabaseTransaction {
    return Object.freeze({
        async query<TRow extends DatabaseRow = DatabaseRow>(
            sql: string,
            values: readonly DatabaseValue[] = [],
            options?: DatabaseCancellation,
        ): Promise<readonly TRow[]> {
            assertBoundDatabaseCurrent(binding);
            const signal = composeDatabaseOperationSignal(binding.signal, options?.signal);
            const rows = await transaction.query<TRow>(sql, values, { signal });
            assertBoundDatabaseCurrent(binding);
            return rows;
        },
        async execute(
            sql: string,
            values: readonly DatabaseValue[] = [],
            options?: DatabaseCancellation,
        ): Promise<DatabaseExecutionResult> {
            assertBoundDatabaseCurrent(binding);
            const signal = composeDatabaseOperationSignal(binding.signal, options?.signal);
            const result = await transaction.execute(sql, values, { signal });
            assertBoundDatabaseCurrent(binding);
            return result;
        },
    });
}

function bindDatabaseHandle(
    database: DatabaseHandle,
    binding: Readonly<{ signal: AbortSignal; isGenerationCurrent(): boolean }>,
): DaemonDatabase {
    return Object.freeze({
        async query<TRow extends DatabaseRow = DatabaseRow>(
            sql: string,
            values: readonly DatabaseValue[] = [],
            options?: DatabaseCancellation,
        ): Promise<readonly TRow[]> {
            assertBoundDatabaseCurrent(binding);
            const signal = composeDatabaseOperationSignal(binding.signal, options?.signal);
            const rows = await database.query<TRow>(sql, values, { signal });
            assertBoundDatabaseCurrent(binding);
            return rows;
        },
        async execute(
            sql: string,
            values: readonly DatabaseValue[] = [],
            options?: DatabaseCancellation,
        ): Promise<DatabaseExecutionResult> {
            assertBoundDatabaseCurrent(binding);
            const signal = composeDatabaseOperationSignal(binding.signal, options?.signal);
            const result = await database.execute(sql, values, { signal });
            assertBoundDatabaseCurrent(binding);
            return result;
        },
        async transaction<T>(
            operation: (transaction: DatabaseTransaction) => Promise<T>,
            options?: DatabaseCancellation,
        ): Promise<T> {
            assertBoundDatabaseCurrent(binding);
            const signal = composeDatabaseOperationSignal(binding.signal, options?.signal);
            const result = await database.transaction(
                async (transaction) => await operation(bindDatabaseTransaction(transaction, binding)),
                { signal },
            );
            assertBoundDatabaseCurrent(binding);
            return result;
        },
    });
}

/**
 * One registry-generation-local Data owner. It deliberately knows neither
 * Platform adoption nor SQL semantics beyond handing exact callbacks to the
 * existing canonical owner; lifecycle calls `prepare()` before publication and
 * `close()` once the registry retires.
 */
export function createStablePluginDaemonDatabaseHost(params: Readonly<{
    paths: PluginStorePaths;
    daemonDatabaseLimits?: PluginDaemonDatabaseLimitsPolicy;
}>): StablePluginDaemonDatabaseHost {
    const preparedByPluginId = new Map<string, PreparedPluginDaemonDatabaseOwner>();
    const quiescedByPluginId = new Map<string, QuiescedPluginDaemonDatabaseOwner>();
    const unavailableCodesByPluginId = new Map<
        string,
        'daemon_database_policy_unavailable' | 'daemon_database_unavailable'
    >();
    const protocolMaximumDatabaseBytes = params.daemonDatabaseLimits
        ? requirePositiveSafeInteger(
            params.daemonDatabaseLimits.protocolMaximumDatabaseBytes,
            'protocolMaximumDatabaseBytes',
        )
        : null;
    let closed = false;
    let closePromise: Promise<void> | null = null;

    const resolvePluginLimits = (pluginId: string): PluginDaemonDatabaseLimits | null => {
        if (!params.daemonDatabaseLimits || protocolMaximumDatabaseBytes === null) return null;
        const limits = params.daemonDatabaseLimits.resolvePluginLimits(pluginId);
        if (!limits) return null;
        const normalized = validateLimits(limits);
        if (normalized.maximumDatabaseBytes > protocolMaximumDatabaseBytes) {
            fail(
                'daemon_database_limits_invalid',
                'Plugin daemon database byte budget exceeds the configured protocol hard ceiling',
            );
        }
        return normalized;
    };

    return Object.freeze({
        async prepare(input): Promise<void> {
            if (closed) fail('daemon_database_closed', 'Plugin daemon database host is closed');
            if (preparedByPluginId.has(input.pluginId)) {
                fail('daemon_database_duplicate_preparation', 'Plugin daemon database owner was prepared more than once');
            }
            const declarations = normalizeDaemonDatabaseDeclarations(input.declarations);
            if (declarations.length === 0) return;
            const limits = resolvePluginLimits(input.pluginId);
            if (!limits) {
                unavailableCodesByPluginId.set(input.pluginId, 'daemon_database_policy_unavailable');
                return;
            }
            const normalized = normalizeRuntimeProjection({
                declarations,
                runtime: input.runtime,
            });
            const incumbentContracts = new Map(
                (input.incumbentContracts ?? []).map((contract) => [contract.id, contract]),
            );
            const owner = createPluginDaemonDatabaseOwner({
                pluginId: input.pluginId,
                paths: params.paths,
                signal: input.signal,
                isGenerationCurrent: input.isGenerationCurrent,
                limits,
                declarations: normalized.map(({ declaration }) => declaration),
                ...(incumbentContracts.size > 0 ? { incumbentContracts } : {}),
            });
            try {
                for (const { declaration, options } of normalized) {
                    await owner.storage.database(declaration.id, options);
                }
            } catch (error) {
                await owner.close().catch(() => undefined);
                throw error;
            }
            if (closed) {
                await owner.close();
                fail('daemon_database_closed', 'Plugin daemon database host closed during preparation');
            }
            preparedByPluginId.set(input.pluginId, Object.freeze({
                generation: input.generation,
                limits,
                owner,
            }));
            unavailableCodesByPluginId.delete(input.pluginId);
        },
        bind(input): DaemonDatabaseService {
            const prepared = preparedByPluginId.get(input.pluginId);
            if (!prepared || prepared.generation !== input.generation || closed) {
                return createUnavailablePluginDaemonDatabaseService(
                    unavailableCodesByPluginId.get(input.pluginId)
                    ?? (params.daemonDatabaseLimits
                        ? 'daemon_database_unavailable'
                        : 'daemon_database_policy_unavailable'),
                );
            }
            const binding = Object.freeze({
                signal: input.signal,
                isGenerationCurrent: input.isGenerationCurrent,
            });
            return Object.freeze({
                async database(name: string, options: DatabaseOpenOptions): Promise<DaemonDatabase> {
                    assertBoundDatabaseCurrent(binding);
                    const signal = composeDatabaseOperationSignal(binding.signal, options.signal);
                    const database = await prepared.owner.storage.database(name, {
                        ...options,
                        signal,
                    });
                    assertBoundDatabaseCurrent(binding);
                    return bindDatabaseHandle(database, binding);
                },
            });
        },
        readPreparedContracts(pluginId): readonly PluginDaemonDatabasePreparedContract[] {
            const prepared = preparedByPluginId.get(pluginId);
            return prepared
                ? Object.freeze([...prepared.owner.readPreparedContracts()])
                : Object.freeze([]);
        },
        async quiesce(pluginIds): Promise<PluginDaemonDatabaseQuiescence> {
            if (closed) fail('daemon_database_closed', 'Plugin daemon database host is closed');
            const acquiredPluginIds: string[] = [];
            try {
                for (const pluginId of [...new Set(pluginIds)].sort()) {
                    const prepared = preparedByPluginId.get(pluginId);
                    if (!prepared) continue;
                    const existing = quiescedByPluginId.get(pluginId);
                    if (existing) {
                        existing.references += 1;
                    } else {
                        quiescedByPluginId.set(pluginId, {
                            references: 1,
                            quiescence: await prepared.owner.quiesce(),
                        });
                    }
                    acquiredPluginIds.push(pluginId);
                }
            } catch (error) {
                await Promise.all(acquiredPluginIds.map(async (pluginId) => {
                    const quiesced = quiescedByPluginId.get(pluginId);
                    if (!quiesced) return;
                    quiesced.references -= 1;
                    if (quiesced.references === 0) {
                        quiescedByPluginId.delete(pluginId);
                        await quiesced.quiescence.resume();
                    }
                }));
                throw error;
            }
            let resumed = false;
            return Object.freeze({
                async resume(): Promise<void> {
                    if (resumed) return;
                    resumed = true;
                    const resumes: Promise<void>[] = [];
                    for (const pluginId of acquiredPluginIds) {
                        const quiesced = quiescedByPluginId.get(pluginId);
                        if (!quiesced) continue;
                        quiesced.references -= 1;
                        if (quiesced.references === 0) {
                            quiescedByPluginId.delete(pluginId);
                            resumes.push(quiesced.quiescence.resume());
                        }
                    }
                    await Promise.all(resumes);
                },
            });
        },
        readCapability(pluginId): PluginDaemonDatabaseCapability {
            const prepared = preparedByPluginId.get(pluginId);
            if (prepared && protocolMaximumDatabaseBytes !== null) {
                return Object.freeze({
                    status: 'available' as const,
                    protocolMaximumDatabaseBytes,
                    limits: prepared.limits,
                });
            }
            return Object.freeze({
                status: 'unavailable' as const,
                code: unavailableCodesByPluginId.get(pluginId)
                    ?? (params.daemonDatabaseLimits
                        ? 'daemon_database_unavailable' as const
                        : 'daemon_database_policy_unavailable' as const),
            });
        },
        async close(): Promise<void> {
            if (closePromise) return await closePromise;
            closed = true;
            closePromise = (async () => {
                const results = await Promise.allSettled(
                    [...preparedByPluginId.values()].map(async ({ owner }) => await owner.close()),
                );
                preparedByPluginId.clear();
                quiescedByPluginId.clear();
                unavailableCodesByPluginId.clear();
                const failures = results
                    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
                    .map((result) => result.reason);
                if (failures.length === 1) throw failures[0];
                if (failures.length > 1) {
                    throw new AggregateError(failures, 'Plugin daemon database host cleanup failed');
                }
            })();
            return await closePromise;
        },
    });
}
