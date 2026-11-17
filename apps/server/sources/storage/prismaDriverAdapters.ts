import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaPg } from "@prisma/adapter-pg";
import type {
    SqlDriverAdapter,
    SqlDriverAdapterFactory,
    SqlQuery,
    SqlResultSet,
    Transaction,
} from "@prisma/driver-adapter-utils";
import * as mariadb from "mariadb";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import pg from "pg";

import type { DbProvider } from "@/config/databaseProvider";
import type { DatabasePoolStats } from "@/app/monitoring/metrics/databaseDriverMetrics";

import { parseSqliteDatabaseUrl, SqliteDriverAdapterFactory } from "./sqliteDriverAdapter";

/**
 * Builds the Prisma 7 driver adapter for a database URL. This is the only place Prisma
 * connection URLs are translated into driver settings, keeping the parameters the Rust
 * engine read from them:
 * - `connection_limit` → pool size (Rust default when absent: physical CPUs × 2 + 1, not the
 *   drivers' own 10); `pool_timeout` (seconds, Rust default 10) → wait for a pooled connection
 *   before failing;
 * - PostgreSQL `schema` → the generated queries' schema and the connection's search_path,
 *   so raw SQL resolves unqualified tables in the same schema as before.
 */
export interface PrismaDriverAdapter {
    readonly factory: SqlDriverAdapterFactory;
    /** Current pool state, read when metrics are scraped. */
    readonly poolStats: () => DatabasePoolStats | null;
}

// Prisma URL parameters the Rust engine consumed; drivers must not see them as their own options.
const PRISMA_URL_PARAMETERS = [
    "connection_limit",
    "pool_timeout",
    "connect_timeout",
    "socket_timeout",
    "schema",
    "pgbouncer",
    "statement_cache_size",
    "sslaccept",
] as const;

const RUST_ENGINE_DEFAULT_POOL_TIMEOUT_SECONDS = 10;

/**
 * Physical cores as the Rust engine counted them (`num_cpus::get_physical`): distinct
 * (physical id, core id) pairs in Linux's /proc/cpuinfo, otherwise the logical CPU count.
 */
export function countPhysicalCpus(cpuInfo: string | null, logicalCpus: number): number {
    const cores = new Set<string>();
    for (const block of (cpuInfo ?? "").split(/\n\s*\n/)) {
        const physical = /^physical id\s*:\s*(\d+)/m.exec(block)?.[1];
        const core = /^core id\s*:\s*(\d+)/m.exec(block)?.[1];
        if (physical !== undefined && core !== undefined) cores.add(`${physical}:${core}`);
    }
    return cores.size > 0 ? cores.size : logicalCpus;
}

function readLinuxCpuInfo(): string | null {
    if (process.platform !== "linux") return null;
    try {
        return readFileSync("/proc/cpuinfo", "utf8");
    } catch {
        return null;
    }
}

/** The Rust engine's pool size for a URL without `connection_limit`: physical CPUs × 2 + 1. */
function resolveDefaultConnectionLimit(): number {
    return countPhysicalCpus(readLinuxCpuInfo(), availableParallelism()) * 2 + 1;
}

function readPositiveNumber(url: URL, name: string): number | null {
    const raw = url.searchParams.get(name);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
}

function stripPrismaParameters(url: URL): string {
    const driverUrl = new URL(url.toString());
    for (const name of PRISMA_URL_PARAMETERS) driverUrl.searchParams.delete(name);
    return driverUrl.toString();
}

function quotePostgresIdentifier(identifier: string): string {
    return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * The Rust engine's TLS reading of a PostgreSQL URL: `sslmode=prefer|require` encrypts and,
 * unless `sslaccept=strict`, accepts any certificate; `sslcert` names the CA certificate file;
 * `verify-full` verifies. node-postgres reads `require` as verify-full, so the mode is
 * translated here instead of being passed through.
 */
function resolvePostgresTls(url: URL): pg.PoolConfig["ssl"] | undefined {
    const mode = url.searchParams.get("sslmode");
    const caPath = url.searchParams.get("sslcert");
    const ca = caPath ? readFileSync(caPath, "utf8") : undefined;
    switch (mode) {
        case null:
            return undefined;
        case "disable":
            return false;
        case "verify-full":
            return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
        default:
            return { rejectUnauthorized: url.searchParams.get("sslaccept") === "strict", ...(ca ? { ca } : {}) };
    }
}

/** One statement as the driver sends it, including transaction framing Prisma's query log omits. */
export type DriverStatement = Readonly<{ query: string; params: readonly unknown[] }>;
export type DriverStatementObserver = (statement: DriverStatement) => void;

function createPostgresAdapter(databaseUrl: string, onDriverStatement?: DriverStatementObserver): PrismaDriverAdapter {
    const url = new URL(databaseUrl);
    const schema = url.searchParams.get("schema") ?? undefined;
    const connectionLimit = readPositiveNumber(url, "connection_limit") ?? resolveDefaultConnectionLimit();
    const poolTimeoutSeconds = readPositiveNumber(url, "pool_timeout") ?? RUST_ENGINE_DEFAULT_POOL_TIMEOUT_SECONDS;
    const ssl = resolvePostgresTls(url);
    const driverUrl = new URL(stripPrismaParameters(url));
    for (const name of ["sslmode", "sslcert"]) driverUrl.searchParams.delete(name);
    const pool = new pg.Pool({
        connectionString: driverUrl.toString(),
        max: connectionLimit,
        connectionTimeoutMillis: Math.round(poolTimeoutSeconds * 1000),
        ...(ssl !== undefined ? { ssl } : {}),
        ...(schema ? { options: `-c search_path=${quotePostgresIdentifier(schema)}` } : {}),
    });
    if (onDriverStatement) {
        // Statement-cost contracts count what reaches PostgreSQL: adapter-pg sends BEGIN and
        // SET TRANSACTION itself, outside the statements Prisma's query log reports.
        pool.on("connect", (client) => {
            const query = client.query.bind(client) as (...args: unknown[]) => unknown;
            (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
                const [config, values] = args;
                const text = typeof config === "string" ? config : (config as { text?: unknown } | null)?.text;
                if (typeof text === "string") {
                    const params = typeof config === "string" ? values : (config as { values?: unknown }).values;
                    onDriverStatement({ query: text, params: Array.isArray(params) ? params : [] });
                }
                return query(...args);
            };
        });
    }
    return {
        factory: new PrismaPg(pool, { ...(schema ? { schema } : {}), disposeExternalPool: true }),
        poolStats: () => ({ open: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }),
    };
}

function createMysqlAdapter(databaseUrl: string): PrismaDriverAdapter {
    const url = new URL(databaseUrl);
    const connectionLimit = readPositiveNumber(url, "connection_limit") ?? resolveDefaultConnectionLimit();
    const poolTimeoutSeconds = readPositiveNumber(url, "pool_timeout") ?? RUST_ENGINE_DEFAULT_POOL_TIMEOUT_SECONDS;
    const driverUrl = new URL(stripPrismaParameters(url));
    driverUrl.protocol = "mariadb:";
    driverUrl.searchParams.set("connectionLimit", String(connectionLimit));
    driverUrl.searchParams.set("acquireTimeout", String(Math.round(poolTimeoutSeconds * 1000)));
    // The adapter's own default for pools it creates: Prisma's plan cache, not the driver, owns reuse.
    driverUrl.searchParams.set("prepareCacheLength", "0");
    // The server-key exchange the Rust engine performed for caching_sha2_password accounts.
    if (!driverUrl.searchParams.has("allowPublicKeyRetrieval")) driverUrl.searchParams.set("allowPublicKeyRetrieval", "true");
    const pool = mariadb.createPool(driverUrl.toString());
    return {
        factory: new PrismaMariaDb(pool, { disposeExternalPool: true }),
        poolStats: () => ({
            open: pool.totalConnections(),
            idle: pool.idleConnections(),
            waiting: pool.taskQueueSize(),
        }),
    };
}

export function createPrismaDriverAdapter(
    provider: DbProvider,
    databaseUrl: string,
    options: Readonly<{ sqliteBusyTimeoutMs: number; onDriverStatement?: DriverStatementObserver }>,
): PrismaDriverAdapter {
    if (provider === "postgres" || provider === "pglite") return createPostgresAdapter(databaseUrl, options.onDriverStatement);
    if (options.onDriverStatement) throw new Error(`Driver statement observation is not implemented for ${provider}`);
    if (provider === "mysql") return createMysqlAdapter(databaseUrl);
    const factory = new SqliteDriverAdapterFactory({
        ...parseSqliteDatabaseUrl(databaseUrl),
        busyTimeoutMs: options.sqliteBusyTimeoutMs,
    });
    return { factory, poolStats: () => factory.poolStats() };
}

/** Times every SQL statement the client sends, for `prisma_datasource_queries_duration_histogram_ms`. */
export function withStatementTiming(
    factory: SqlDriverAdapterFactory,
    observeMs: (durationMs: number) => void,
): SqlDriverAdapterFactory {
    const timed = async <T>(run: () => Promise<T>): Promise<T> => {
        const startedAt = performance.now();
        try {
            return await run();
        } finally {
            observeMs(performance.now() - startedAt);
        }
    };
    // Explicit delegation: driver adapters keep #private state, so their methods must run on themselves.
    const timeTransaction = (transaction: Transaction): Transaction => ({
        provider: transaction.provider,
        adapterName: transaction.adapterName,
        options: transaction.options,
        queryRaw: (query: SqlQuery): Promise<SqlResultSet> => timed(() => transaction.queryRaw(query)),
        executeRaw: (query: SqlQuery): Promise<number> => timed(() => transaction.executeRaw(query)),
        commit: () => transaction.commit(),
        rollback: () => transaction.rollback(),
        ...(transaction.createSavepoint ? { createSavepoint: (name: string) => transaction.createSavepoint!(name) } : {}),
        ...(transaction.rollbackToSavepoint ? { rollbackToSavepoint: (name: string) => transaction.rollbackToSavepoint!(name) } : {}),
        ...(transaction.releaseSavepoint ? { releaseSavepoint: (name: string) => transaction.releaseSavepoint!(name) } : {}),
    });
    return {
        provider: factory.provider,
        adapterName: factory.adapterName,
        async connect(): Promise<SqlDriverAdapter> {
            const adapter = await factory.connect();
            return {
                provider: adapter.provider,
                adapterName: adapter.adapterName,
                queryRaw: (query: SqlQuery): Promise<SqlResultSet> => timed(() => adapter.queryRaw(query)),
                executeRaw: (query: SqlQuery): Promise<number> => timed(() => adapter.executeRaw(query)),
                executeScript: (script: string) => adapter.executeScript(script),
                startTransaction: async (...args: Parameters<SqlDriverAdapter["startTransaction"]>) =>
                    timeTransaction(await adapter.startTransaction(...args)),
                ...(adapter.getConnectionInfo ? { getConnectionInfo: () => adapter.getConnectionInfo!() } : {}),
                dispose: () => adapter.dispose(),
            };
        },
    };
}
