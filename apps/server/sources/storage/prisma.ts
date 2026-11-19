import type { Prisma as PrismaNamespace, PrismaClient as PrismaClientInstance } from "@prisma/client";
import { PGlite } from "@electric-sql/pglite";
import { FramedPgliteSocketServer } from "./pgliteFramedSocketServer.mjs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { acquirePgliteDirLock } from "./locks/pgliteLock";
import { resolveLightSqliteBusyTimeoutMsFromEnv } from "@/flavors/light/sqliteConnectionConfig";
import { log, warn } from "@/utils/logging/log";
import { AsyncLock } from "@/utils/runtime/lock";
import { databaseQueryDurationHistogram, registerDatabasePoolStatsReader } from "@/app/monitoring/metrics/databaseDriverMetrics";
import { readMetricsServerConfigFromEnv } from "@/config/monitoring";
import { readDatabaseTransactionConfigFromEnv } from "@/config/databaseTransactions";
import { isSharedDatabaseConsumer } from "@/config/sharedDatabaseConsumer";
import {
    createDefaultPrismaClient,
    createGeneratedPrismaClient,
    loadDefaultPrismaClientModule,
    withConnectionLimit,
} from "./prismaClientConstruction";
import { isPrismaErrorCode, readPrismaDriverErrorCause, readSharedQaSchemaMismatchDiagnostic, withPrismaQueryValidationDiagnostic } from './prismaErrors';
import { annotateWebLatencyQuery, timeWebLatencyPhase } from '@/utils/webLatencyTrace';
import { notifySqliteCommittedWrite } from './sqliteCommittedWrites';
export { isPrismaErrorCode } from './prismaErrors';
export type TransactionClient = PrismaNamespace.TransactionClient;
export type PrismaClientType = PrismaClientInstance;
export {
    applyConfiguredDatabaseConnectionLimit,
    createDbMaintenanceClient,
    createDbSqliteMaintenanceClient,
    loadPackagedPrismaClientModule,
    onDbClientQuery,
    resolveGeneratedClientEntrypoint,
    resolvePackagedDefaultPrismaClientEntrypoint,
    resolvePackagedGeneratedClientEntrypoint,
    resolvePreferredGeneratedClientEntrypoint,
    type DbClientLog,
} from "./prismaClientConstruction";

export * from "./enums.generated";

import type { DbProvider } from '@/config/databaseProvider';
export { parseDbProvider, getDbProviderFromEnv, requireDbProviderFromEnv, type DbProvider } from '@/config/databaseProvider';

/**
 * Canonical provider-matched runtime Prisma namespace.
 *
 * Runtime callers must use this sidecar-aware CommonJS loader instead of a
 * named ESM import from `@prisma/client`; packaged server builds externalize
 * Prisma and cannot rely on named-import interop from its generated module.
 * SQL objects must come from the active client's runtime: query extensions clone
 * their arguments using that runtime's Sql class and otherwise lose SQL getters.
 * Construct fragments after database initialization; cache their text, not Sql objects.
 */
const defaultPrismaRuntime = loadDefaultPrismaClientModule().Prisma;
let activePrismaRuntime: typeof import("@prisma/client").Prisma | null = null;
export const prismaRuntime: typeof import("@prisma/client").Prisma = new Proxy(defaultPrismaRuntime, {
    get(_target, property) {
        return Reflect.get(activePrismaRuntime ?? defaultPrismaRuntime, property);
    },
});

/** Provider-matched Prisma namespace for sentinels such as `DbNull`. */
export function getActivePrismaRuntime(): typeof import("@prisma/client").Prisma {
    if (!activePrismaRuntime) {
        throw new Error("Database client is not initialized. Prisma runtime sentinel is unavailable.");
    }
    return activePrismaRuntime;
}

function withSharedQaSchemaDiagnostics(client: PrismaClientType): PrismaClientType {
    if (!isSharedDatabaseConsumer(process.env) && process.env.HAPPIER_WEB_LATENCY_TRACE !== '1') return client;
    const extended = client.$extends({
        query: {
            async $allOperations({ args, query, model, operation }) {
                try {
                    return await timeWebLatencyPhase(`db.${model ?? 'raw'}.${operation}`, () => query(
                        (operation === '$queryRawUnsafe' || operation === '$executeRawUnsafe')
                            && Array.isArray(args) && typeof args[0] === 'string'
                            ? [annotateWebLatencyQuery(args[0]), ...args.slice(1)] : args,
                    ));
                } catch (error) {
                    const diagnostic = readSharedQaSchemaMismatchDiagnostic(error);
                    // Preserve Prisma's code, metadata and identity for existing error owners.
                    // All socket event logs that interpolate the error now carry the reload action.
                    if (diagnostic && error instanceof Error) error.message = diagnostic.message;
                    throw withPrismaQueryValidationDiagnostic(error, { model, operation });
                }
            },
        },
    });
    // Query diagnostics do not change the generated client's public contract.
    // Retain that contract while forwarding queries with the extended receiver.
    return new Proxy(client, {
        get(_target, property) {
            const value = Reflect.get(extended, property, extended);
            return typeof value === 'function' ? value.bind(extended) : value;
        },
    });
}

const SQLITE_READ_OPERATIONS: ReadonlySet<string> = new Set([
    "findUnique",
    "findUniqueOrThrow",
    "findFirst",
    "findFirstOrThrow",
    "findMany",
    "count",
    "aggregate",
    "groupBy",
]);

/**
 * Reports every completed non-read operation of the light server's primary SQLite
 * client to the committed-write edge. Raw SQL counts as a write: it can mutate, and
 * an extra checkpoint after a raw read is harmless while a missed write is not.
 * A write inside an interactive transaction reports before COMMIT; the consumer
 * (WAL maintenance) acts an interval later, never synchronously.
 */
function withSqliteCommittedWriteSignal(client: PrismaClientType): PrismaClientType {
    const extended = client.$extends({
        query: {
            async $allOperations({ args, query, operation }) {
                const result = await query(args);
                if (!SQLITE_READ_OPERATIONS.has(operation)) notifySqliteCommittedWrite();
                return result;
            },
        },
    });
    // Same contract-preserving forwarding as the query diagnostics wrapper above.
    return new Proxy(client, {
        get(_target, property) {
            const value = Reflect.get(extended, property, extended);
            return typeof value === "function" ? value.bind(extended) : value;
        },
    });
}

/** Clients that serve requests feed the statement-duration histogram when the metrics server is on. */
function runtimeClientOptions(): Readonly<{ observeStatementDurationMs?: (durationMs: number) => void }> {
    return readMetricsServerConfigFromEnv(process.env).enabled
        ? { observeStatementDurationMs: (durationMs) => databaseQueryDurationHistogram.observe(durationMs) }
        : {};
}

let _db: ReturnType<typeof withSharedQaSchemaDiagnostics> | null = null;
let _pglite: PGlite | null = null;
let _pgliteServer: FramedPgliteSocketServer | null = null;
let _provider: DbProvider | null = null;
let _connectionPool: {
    connectionLimit: number | null;
    transactionAdmission: AsyncLock | undefined;
} | null = null;
let _releasePgliteDirLock: (() => Promise<void>) | null = null;
let _initDbPgliteInFlight: Promise<void> | null = null;
let sqliteReadSnapshot: {
    databaseUrl: string;
    env: NodeJS.ProcessEnv;
    lock: AsyncLock;
    client: ReturnType<typeof withSharedQaSchemaDiagnostics> | null;
} | null = null;
let _sqliteReadinessClient: PrismaClientType | null = null;

export const db: PrismaClientType = new Proxy({} as PrismaClientType, {
    get(_target, prop) {
        if (!_db) {
            if (prop === Symbol.toStringTag) return "PrismaClient";
            // Avoid accidental `await db` treating it like a thenable.
            if (prop === "then") return undefined;
            throw new Error(
                "Database client is not initialized. Call initDbPostgres(), initDbMysql(), initDbSqlite(), or initDbPglite() before using db.",
            );
        }
        const value = (_db as any)[prop];
        return typeof value === "function" ? value.bind(_db) : value;
    },
    set(_target, prop, value) {
        if (!_db) {
            throw new Error(
                "Database client is not initialized. Call initDbPostgres(), initDbMysql(), initDbSqlite(), or initDbPglite() before using db.",
            );
        }
        (_db as any)[prop] = value;
        return true;
    },
}) as PrismaClientType;

export function initDbPostgres(): void {
    if (_db || _pglite || _pgliteServer) {
        throw new Error("Database client is already initialized.");
    }
    _provider = "postgres";
    const { client, poolStats } = createDefaultPrismaClient(undefined, "postgres", runtimeClientOptions());
    _db = withSharedQaSchemaDiagnostics(client);
    registerDatabasePoolStatsReader(poolStats);
    activePrismaRuntime = defaultPrismaRuntime;
    initializeConnectionPool("postgres");
}

async function initDbFromGeneratedClient(provider: "mysql" | "sqlite"): Promise<void> {
    if (_db || _pglite || _pgliteServer) {
        throw new Error("Database client is already initialized.");
    }
    _provider = provider;
    const generated = await createGeneratedPrismaClient(provider, undefined, runtimeClientOptions());
    _db = withSharedQaSchemaDiagnostics(
        provider === "sqlite" ? withSqliteCommittedWriteSignal(generated.client) : generated.client,
    );
    registerDatabasePoolStatsReader(generated.poolStats);
    activePrismaRuntime = generated.prisma;
    initializeConnectionPool(provider);
}

export async function initDbMysql(): Promise<void> {
    await initDbFromGeneratedClient("mysql");
}

export async function initDbSqlite(): Promise<void> {
    await initDbFromGeneratedClient("sqlite");
    if (!_db) {
        throw new Error("Database client is not initialized after initDbFromGeneratedClient(sqlite).");
    }
    await applySqliteRuntimePragmas(_db, process.env);
    if (!process.env.DATABASE_URL) throw new Error("SQLite DATABASE_URL is unavailable.");
    sqliteReadSnapshot = {
        databaseUrl: withConnectionLimit(process.env.DATABASE_URL, 1),
        env: { ...process.env },
        lock: new AsyncLock(),
        client: null,
    };
    _sqliteReadinessClient = (await createGeneratedPrismaClient(
        "sqlite",
        withConnectionLimit(process.env.DATABASE_URL, 1),
    )).client;
    const diagnostics = resolveSqliteStartupDiagnosticsFromEnv(process.env);
    log(
        { module: "storage", event: "sqlite-startup-diagnostics", sqlite: diagnostics },
        "SQLite startup diagnostics",
    );
    if (diagnostics.ignoredDatabaseUrlQueryParameters.length > 0) {
        warn(
            {
                module: "storage",
                event: "sqlite-unsupported-url-query-parameters",
                ignoredDatabaseUrlQueryParameters: diagnostics.ignoredDatabaseUrlQueryParameters,
                databaseUrlPoolAcquisitionTimeoutStatus: diagnostics.databaseUrlPoolAcquisitionTimeoutStatus,
            },
            "SQLite ignores unsupported database URL query parameters; pool acquisition remains unbounded",
        );
    }
}

/**
 * Keep snapshot reads off the write pool with one storage-owned connection.
 * The existing lock serializes transactions on that single connection;
 * query_only prevents a read callback from accidentally becoming a writer.
 */
export async function withSqliteReadSnapshot<T>(
    read: (reader: TransactionClient) => Promise<T>,
    options: Readonly<{
        deadlineAtMs?: number;
        /** The read issues exactly one statement: SQLite runs it as its own snapshot, with no BEGIN/ROLLBACK frame. */
        singleStatement?: boolean;
    }> = {},
): Promise<T> {
    const state = sqliteReadSnapshot;
    if (!state) throw new Error("SQLite database client is not initialized.");
    return await state.lock.inLock(async () => {
        if (sqliteReadSnapshot !== state) throw new Error("SQLite database client is shutting down.");
        if (!state.client) {
            const { client } = await createGeneratedPrismaClient("sqlite", state.databaseUrl, runtimeClientOptions());
            try {
                // The adapter owns the busy wait (resolveSqliteRuntimePragmasFromEnv busy timeout).
                await client.$queryRawUnsafe("PRAGMA query_only=ON;");
                state.client = withSharedQaSchemaDiagnostics(client);
            } catch (error) {
                await client.$disconnect();
                throw error;
            }
        }
        const client = state.client;
        // An autocommit statement is atomic and sees one committed state; the read-only
        // connection keeps it off the writer queue either way.
        if (options.singleStatement) return await read(client);
        // Give Prisma the transaction context so internally chunked relation reads
        // share this snapshot rather than attempting a second BEGIN on the connection.
        // Reuse the transaction owner's budgets instead of Prisma's shorter defaults.
        const config = readDatabaseTransactionConfigFromEnv(process.env, "sqlite");
        return await client.$transaction(read, {
            isolationLevel: "Serializable", maxWait: config.maxWaitMs, timeout: config.timeoutMs,
        });
    }, options);
}

function resolveLightPgliteDirFromEnv(env: NodeJS.ProcessEnv): string {
    const fromEnv = (env.HAPPIER_SERVER_LIGHT_DB_DIR ?? env.HAPPY_SERVER_LIGHT_DB_DIR)?.trim();
    if (fromEnv) return fromEnv;

    const dataDir = (env.HAPPIER_SERVER_LIGHT_DATA_DIR ?? env.HAPPY_SERVER_LIGHT_DATA_DIR)?.trim();
    if (!dataDir) {
        throw new Error(
            "Missing HAPPIER_SERVER_LIGHT_DATA_DIR/HAPPY_SERVER_LIGHT_DATA_DIR (expected applyLightDefaultEnv to set it)",
        );
    }
    return join(dataDir, "pglite");
}


export async function initDbPglite(): Promise<void> {
    if (_db || _pglite || _pgliteServer) {
        throw new Error("Database client is already initialized.");
    }
    if (_initDbPgliteInFlight) {
        throw new Error("PGlite initialization is already in progress.");
    }

    const initPromise = (async () => {
        const dbDir = resolveLightPgliteDirFromEnv(process.env);
        await mkdir(dbDir, { recursive: true });

        const releaseLock = await acquirePgliteDirLock(dbDir, { purpose: "server:initDbPglite" });

        let pglite: PGlite | null = null;
        let server: FramedPgliteSocketServer | null = null;
        try {
            pglite = new PGlite(dbDir);
            // `PGlite` initializes asynchronously. Ensure it's ready before starting the socket server.
            await pglite.waitReady;
            server = new FramedPgliteSocketServer({
                db: pglite,
                host: "127.0.0.1",
                port: 0,
            });
            await server.start();

            // The Socket server returns a Postgres connection string. Ensure Prisma uses a single connection
            // because pglite is single-connection.
            process.env.DATABASE_URL = withConnectionLimit(server.getServerConn(), 1);

            const { client: prismaClient, poolStats } = createDefaultPrismaClient(process.env.DATABASE_URL, 'pglite', runtimeClientOptions());
            _pglite = pglite;
            _pgliteServer = server;
            _provider = "pglite";
            _db = withSharedQaSchemaDiagnostics(prismaClient);
            registerDatabasePoolStatsReader(poolStats);
            activePrismaRuntime = defaultPrismaRuntime;
            initializeConnectionPool("pglite");
            _releasePgliteDirLock = releaseLock;
        } catch (e) {
            if (server) {
                await server.stop().catch(() => {});
            }
            if (pglite) {
                await pglite.close().catch(() => {});
            }
            await releaseLock().catch(() => {});
            throw e;
        }
    })();

    _initDbPgliteInFlight = initPromise;
    try {
        await initPromise;
    } finally {
        _initDbPgliteInFlight = null;
    }
}

export function isPrismaUniqueConstraintError(err: unknown): boolean {
    if (isPrismaErrorCode(err, "P2002")) {
        return true;
    }
    const cause = readPrismaDriverErrorCause(err);
    if (cause?.kind === "UniqueConstraintViolation") return true;
    // SQLITE_CONSTRAINT_UNIQUE / _PRIMARYKEY, MySQL ER_DUP_ENTRY, PostgreSQL unique_violation.
    return cause !== null && (cause.code === "2067" || cause.code === "1555" || cause.code === "1062" || cause.code === "23505");
}

type SqliteJournalMode = "WAL" | "DELETE";
type SqliteSynchronousMode = "OFF" | "NORMAL" | "FULL" | "EXTRA";

export type SqliteRuntimePragmas = Readonly<{
    journalMode: SqliteJournalMode;
    synchronous: SqliteSynchronousMode;
    busyTimeoutMs: number;
    journalSizeLimitBytes: number;
}>;

export type SqliteDatabaseUrlConnectionLimitStatus = "configured" | "missing" | "invalid";

export type SqliteStartupDiagnostics = Readonly<{
    provider: "sqlite";
    journalMode: SqliteJournalMode;
    synchronous: SqliteSynchronousMode;
    busyTimeoutMs: number;
    journalSizeLimitBytes: number;
    databaseUrlSocketTimeoutSeconds: number | null;
    databaseUrlConnectionLimit: number | null;
    databaseUrlConnectionLimitStatus: SqliteDatabaseUrlConnectionLimitStatus;
    databaseUrlPoolAcquisitionTimeoutStatus: "unbounded";
    ignoredDatabaseUrlQueryParameters: readonly string[];
}>;

// Cap the WAL file retained after a checkpoint. SQLite's default (-1) means
// "no limit", so this is a safety net alongside the active checkpoint worker.
const DEFAULT_SQLITE_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

function resolveSqliteJournalModeFromEnv(env: NodeJS.ProcessEnv): SqliteJournalMode {
    const raw = String(env.HAPPIER_SQLITE_JOURNAL_MODE ?? env.HAPPY_SQLITE_JOURNAL_MODE ?? "").trim();
    if (!raw) return "WAL";
    const normalized = raw.toUpperCase();
    if (normalized === "WAL") return "WAL";
    if (normalized === "DELETE") return "DELETE";
    throw new Error(`Invalid HAPPIER_SQLITE_JOURNAL_MODE/HAPPY_SQLITE_JOURNAL_MODE: ${raw}`);
}

function resolveSqliteSynchronousModeFromEnv(env: NodeJS.ProcessEnv): SqliteSynchronousMode {
    const raw = String(env.HAPPIER_SQLITE_SYNCHRONOUS ?? env.HAPPY_SQLITE_SYNCHRONOUS ?? "").trim();
    if (!raw) return "NORMAL";
    const normalized = raw.toUpperCase();
    if (normalized === "OFF") return "OFF";
    if (normalized === "NORMAL") return "NORMAL";
    if (normalized === "FULL") return "FULL";
    if (normalized === "EXTRA") return "EXTRA";
    throw new Error(`Invalid HAPPIER_SQLITE_SYNCHRONOUS/HAPPY_SQLITE_SYNCHRONOUS: ${raw}`);
}

function resolveSqliteBusyTimeoutMsFromEnv(env: NodeJS.ProcessEnv): number {
    return resolveLightSqliteBusyTimeoutMsFromEnv(env);
}

function resolveSqliteJournalSizeLimitBytesFromEnv(env: NodeJS.ProcessEnv): number {
    const raw = String(
        env.HAPPIER_SQLITE_JOURNAL_SIZE_LIMIT_BYTES ?? env.HAPPY_SQLITE_JOURNAL_SIZE_LIMIT_BYTES ?? "",
    ).trim();
    if (!raw) return DEFAULT_SQLITE_JOURNAL_SIZE_LIMIT_BYTES;
    if (!/^-?\d+$/.test(raw)) {
        throw new Error(
            `Invalid HAPPIER_SQLITE_JOURNAL_SIZE_LIMIT_BYTES/HAPPY_SQLITE_JOURNAL_SIZE_LIMIT_BYTES: ${raw}`,
        );
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(
            `Invalid HAPPIER_SQLITE_JOURNAL_SIZE_LIMIT_BYTES/HAPPY_SQLITE_JOURNAL_SIZE_LIMIT_BYTES: ${raw}`,
        );
    }
    // SQLite treats negative values as "no limit"; 0 is an explicit minimum-size limit.
    return parsed;
}

export function resolveSqliteRuntimePragmasFromEnv(env: NodeJS.ProcessEnv): SqliteRuntimePragmas {
    return {
        journalMode: resolveSqliteJournalModeFromEnv(env),
        synchronous: resolveSqliteSynchronousModeFromEnv(env),
        busyTimeoutMs: resolveSqliteBusyTimeoutMsFromEnv(env),
        journalSizeLimitBytes: resolveSqliteJournalSizeLimitBytesFromEnv(env),
    };
}

function parsePositiveInteger(value: string | null): number | null {
    if (value === null) return null;
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function readDatabaseUrlSearchParam(env: NodeJS.ProcessEnv, key: string): string | null {
    const rawUrl = String(env.DATABASE_URL ?? "").trim();
    if (!rawUrl) return null;
    try {
        return new URL(rawUrl).searchParams.get(key);
    } catch {
        return null;
    }
}

function initializeConnectionPool(provider: DbProvider): void {
    // The URL already includes the provider's effective connection-limit
    // override. Parse it once for the same lifetime as the native pool.
    const connectionLimit = parsePositiveInteger(readDatabaseUrlSearchParam(process.env, "connection_limit"));
    _connectionPool = {
        connectionLimit,
        // Keep one explicit PostgreSQL pool slot for Machine validation,
        // presence and RPC discovery. Unknown or single-slot pools stay
        // unbounded here; read and write transactions share this admission.
        transactionAdmission: provider === "postgres" && connectionLimit !== null && connectionLimit > 1
            ? new AsyncLock(connectionLimit - 1) : undefined,
    };
}

/** The initialized pool's explicit budget; absence never implies a guessed size. */
export function getPrismaConnectionLimit(): number | null {
    return _connectionPool?.connectionLimit ?? null;
}

export function getPooledTransactionAdmission(): AsyncLock | undefined {
    return _connectionPool?.transactionAdmission;
}

export function resolveSqliteStartupDiagnosticsFromEnv(env: NodeJS.ProcessEnv): SqliteStartupDiagnostics {
    const pragmas = resolveSqliteRuntimePragmasFromEnv(env);
    const rawConnectionLimit = readDatabaseUrlSearchParam(env, "connection_limit");
    const databaseUrlConnectionLimit = parsePositiveInteger(rawConnectionLimit);
    const databaseUrlConnectionLimitStatus: SqliteDatabaseUrlConnectionLimitStatus =
        rawConnectionLimit === null ? "missing" : databaseUrlConnectionLimit === null ? "invalid" : "configured";
    const ignoredDatabaseUrlQueryParameters = [
        ...(readDatabaseUrlSearchParam(env, "pool_timeout") !== null ? ["pool_timeout"] : []),
    ];

    return {
        provider: "sqlite",
        journalMode: pragmas.journalMode,
        synchronous: pragmas.synchronous,
        busyTimeoutMs: pragmas.busyTimeoutMs,
        journalSizeLimitBytes: pragmas.journalSizeLimitBytes,
        databaseUrlSocketTimeoutSeconds: parsePositiveInteger(readDatabaseUrlSearchParam(env, "socket_timeout")),
        databaseUrlConnectionLimit,
        databaseUrlConnectionLimitStatus,
        databaseUrlPoolAcquisitionTimeoutStatus: "unbounded",
        ignoredDatabaseUrlQueryParameters,
    };
}

export async function applySqliteRuntimePragmas(client: Pick<PrismaClientType, "$queryRawUnsafe">, env: NodeJS.ProcessEnv): Promise<void> {
    const pragmas = resolveSqliteRuntimePragmasFromEnv(env);
    // These PRAGMA values come from strict allow-list / numeric-range resolvers above.
    // Keep the resolution step as the SQL safety boundary for these raw statements.
    await client.$queryRawUnsafe(`PRAGMA journal_mode=${pragmas.journalMode};`);
    await client.$queryRawUnsafe(`PRAGMA synchronous=${pragmas.synchronous};`);
    await client.$queryRawUnsafe(`PRAGMA journal_size_limit=${pragmas.journalSizeLimitBytes};`);
}

// Readiness checks the database on its own SQLite connection. The server-light app pool
// is deliberately a single connection, so one slow application read would otherwise queue
// the probe behind it (#832). Reading `sqlite_master` opens a read transaction on the file,
// so an unreadable or non-database file fails the probe; SQLite answers `SELECT 1` without
// touching the file. Other providers keep `SELECT 1` on the app pool.
export async function probeDbReadiness(): Promise<void> {
    if (_sqliteReadinessClient) {
        await _sqliteReadinessClient.$queryRawUnsafe("SELECT count(*) FROM sqlite_master;");
        return;
    }
    await db.$queryRaw`SELECT 1`;
}

export async function disconnectDbReadinessProbe(): Promise<void> {
    const readinessClient = _sqliteReadinessClient;
    _sqliteReadinessClient = null;
    await readinessClient?.$disconnect();
}

export async function shutdownDbClient(): Promise<void> {
    if (_pglite || _pgliteServer || _provider === "pglite") {
        throw new Error("shutdownDbClient() cannot shut down PGlite; call shutdownDbPglite() instead");
    }
    await disconnectDbReadinessProbe();
    const reader = sqliteReadSnapshot;
    sqliteReadSnapshot = null;
    if (reader) {
        await reader.lock.inLock(async () => { await reader.client?.$disconnect(); });
    }
    const client = _db;
    _db = null;
    _provider = null;
    _connectionPool = null;
    activePrismaRuntime = null;
    registerDatabasePoolStatsReader(null);
    if (client) {
        await client.$disconnect();
    }
}

export async function shutdownDbPglite(): Promise<void> {
    if (_provider !== "pglite") {
        throw new Error(`shutdownDbPglite() called when provider is ${_provider ?? "unset"}`);
    }
    const client = _db;
    _db = null;
    _provider = null;
    _connectionPool = null;
    activePrismaRuntime = null;
    registerDatabasePoolStatsReader(null);
    if (client) {
        await client.$disconnect();
    }

    const server = _pgliteServer;
    _pgliteServer = null;
    if (server) {
        await server.stop();
    }

    const pglite = _pglite;
    _pglite = null;
    if (pglite) {
        await pglite.close();
    }

    const release = _releasePgliteDirLock;
    _releasePgliteDirLock = null;
    if (release) {
        await release().catch(() => {});
    }
}
