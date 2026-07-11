import type { Prisma as PrismaNamespace, PrismaClient as PrismaClientInstance } from "@prisma/client";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { acquirePgliteDirLock } from "./locks/pgliteLock";
import { resolveLightSqliteBusyTimeoutMsFromEnv } from "@/flavors/light/sqliteConnectionConfig";
export type TransactionClient = PrismaNamespace.TransactionClient;
export type PrismaClientType = PrismaClientInstance;

export * from "./enums.generated";

export type DbProvider = "postgres" | "pglite" | "sqlite" | "mysql";

const requireFromHere = createRequire(import.meta.url);

export function resolvePackagedDefaultPrismaClientEntrypoint(executablePath: string = process.execPath): string {
    return join(dirname(executablePath), "node_modules", ".prisma", "client", "index.js");
}

export function loadPackagedPrismaClientModule(
    executablePath: string = process.execPath,
): typeof import("@prisma/client") | null {
    const packagedEntrypoint = resolvePackagedDefaultPrismaClientEntrypoint(executablePath);
    if (!existsSync(packagedEntrypoint)) {
        return null;
    }
    const requireFromPackagedEntrypoint = createRequire(pathToFileURL(packagedEntrypoint).href);
    return requireFromPackagedEntrypoint(packagedEntrypoint) as typeof import("@prisma/client");
}

function loadDefaultPrismaClientModule(): typeof import("@prisma/client") {
    const packaged = loadPackagedPrismaClientModule();
    if (packaged) {
        return packaged;
    }
    return requireFromHere("@prisma/client") as typeof import("@prisma/client");
}

/**
 * Canonical runtime Prisma namespace.
 *
 * Runtime callers must use this sidecar-aware CommonJS loader instead of a
 * named ESM import from `@prisma/client`; packaged server builds externalize
 * Prisma and cannot rely on named-import interop from its generated module.
 */
export const prismaRuntime: typeof import("@prisma/client").Prisma = loadDefaultPrismaClientModule().Prisma;

function createDefaultPrismaClient(): PrismaClientType {
    const { PrismaClient } = loadDefaultPrismaClientModule();
    return new PrismaClient();
}

export function applyConfiguredDatabaseConnectionLimit(rawUrl: string, env: NodeJS.ProcessEnv): string {
    const rawLimit = env.HAPPIER_DB_CONNECTION_LIMIT?.trim() || env.HAPPY_DB_CONNECTION_LIMIT?.trim();
    if (!rawLimit) {
        return rawUrl;
    }

    const parsed = Number.parseInt(rawLimit, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return rawUrl;
    }

    return withConnectionLimit(rawUrl, parsed);
}

export function getDbProviderFromEnv(env: NodeJS.ProcessEnv, fallback: DbProvider): DbProvider {
    const raw = (env.HAPPIER_DB_PROVIDER ?? env.HAPPY_DB_PROVIDER)?.toString().trim().toLowerCase();
    if (!raw) return fallback;
    if (raw === "postgresql" || raw === "postgres") return "postgres";
    if (raw === "pglite") return "pglite";
    if (raw === "sqlite") return "sqlite";
    if (raw === "mysql") return "mysql";
    return fallback;
}

export function resolveGeneratedClientEntrypoint(modulePath: string): string {
    const trimmed = modulePath.trim();
    if (/\.(?:mjs|cjs|js)$/.test(trimmed)) return trimmed;
    return trimmed.endsWith("/") ? `${trimmed}index.js` : `${trimmed}/index.js`;
}

export function resolvePackagedGeneratedClientEntrypoint(
    provider: "mysql" | "sqlite",
    executablePath: string = process.execPath,
): string {
    return join(dirname(executablePath), "generated", `${provider}-client`, "index.js");
}

export function resolvePreferredGeneratedClientEntrypoint(
    provider: "mysql" | "sqlite",
    executablePath: string = process.execPath,
): string {
    const packaged = resolvePackagedGeneratedClientEntrypoint(provider, executablePath);
    // Compiled binaries (e.g. Bun --compile) may embed workspace paths into generated Prisma clients
    // (import.meta.url / __dirname). Prefer the on-disk packaged client next to the executable when present.
    if (existsSync(packaged)) {
        return packaged;
    }
    return provider === "mysql"
        ? resolveGeneratedClientEntrypoint("../../generated/mysql-client")
        : resolveGeneratedClientEntrypoint("../../generated/sqlite-client");
}

let _db: PrismaClientType | null = null;
let _pglite: PGlite | null = null;
let _pgliteServer: PGLiteSocketServer | null = null;
let _provider: DbProvider | null = null;
let _releasePgliteDirLock: (() => Promise<void>) | null = null;
let _initDbPgliteInFlight: Promise<void> | null = null;

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
    if (process.env.DATABASE_URL) {
        process.env.DATABASE_URL = applyConfiguredDatabaseConnectionLimit(process.env.DATABASE_URL, process.env);
    }
    _db = createDefaultPrismaClient();
}

async function importGeneratedClient(provider: "mysql" | "sqlite"): Promise<any> {
    const preferred = resolvePreferredGeneratedClientEntrypoint(provider);
    if (isAbsolute(preferred)) {
        try {
            return await import(pathToFileURL(preferred).href);
        } catch {
            // Fall back to workspace path below.
        }
    }
    try {
        if (provider === "mysql") {
            return await import("../../generated/mysql-client/index.js");
        }
        return await import("../../generated/sqlite-client/index.js");
    } catch (error) {
        const packagedEntrypoint = resolvePackagedGeneratedClientEntrypoint(provider);
        try {
            return await import(pathToFileURL(packagedEntrypoint).href);
        } catch {
            throw error;
        }
    }
}

async function initDbFromGeneratedClient(provider: "mysql" | "sqlite"): Promise<void> {
    if (_db || _pglite || _pgliteServer) {
        throw new Error("Database client is already initialized.");
    }
    _provider = provider;
    _db = await createGeneratedPrismaClient(provider);
}

async function createGeneratedPrismaClient(provider: "mysql" | "sqlite"): Promise<PrismaClientType> {
    const entrypoint =
        provider === "mysql"
            ? resolveGeneratedClientEntrypoint("../../generated/mysql-client")
            : resolveGeneratedClientEntrypoint("../../generated/sqlite-client");
    let mod: any;
    try {
        mod = await importGeneratedClient(provider);
    } catch (err: any) {
        const code = err?.code ? String(err.code) : "";
        const hint =
            `This usually means the server was built without the ${provider} Prisma client. Rebuild with HAPPIER_BUILD_DB_PROVIDERS including ${provider} (or leave it unset to build all providers).`;
        if (code === "ERR_MODULE_NOT_FOUND" || /Cannot find module/i.test(String(err?.message ?? ""))) {
            throw new Error(
                `Missing generated Prisma client for provider ${provider} (${entrypoint}). ${hint}`.trim(),
            );
        }
        throw err;
    }
    if (!mod?.PrismaClient) {
        throw new Error(`Invalid generated Prisma client module: ${entrypoint}`);
    }
    return new mod.PrismaClient() as PrismaClientType;
}

export async function createDbSqliteMaintenanceClient(): Promise<PrismaClientType> {
    return createGeneratedPrismaClient("sqlite");
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

function withConnectionLimit(rawUrl: string, limit: number): string {
    const url = (() => {
        try {
            return new URL(rawUrl);
        } catch {
            // `PGLiteSocketServer#getServerConn()` returns `host:port` (no scheme). Prisma expects a full Postgres URL.
            // Disable SSL: pglite-socket does not support TLS negotiation.
            return new URL(`postgresql://postgres@${rawUrl}/postgres?sslmode=disable`);
        }
    })();
    url.searchParams.set("connection_limit", String(limit));
    return url.toString();
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
        let server: PGLiteSocketServer | null = null;
        try {
            pglite = new PGlite(dbDir);
            // `PGlite` initializes asynchronously. Ensure it's ready before starting the socket server.
            await pglite.waitReady;
            server = new PGLiteSocketServer({
                db: pglite,
                host: "127.0.0.1",
                port: 0,
            });
            await server.start();

            // The Socket server returns a Postgres connection string. Ensure Prisma uses a single connection
            // because pglite is single-connection.
            process.env.DATABASE_URL = withConnectionLimit(server.getServerConn(), 1);

            const prismaClient = createDefaultPrismaClient();
            _pglite = pglite;
            _pgliteServer = server;
            _provider = "pglite";
            _db = prismaClient;
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

export function isPrismaErrorCode(err: unknown, code: string): boolean {
    if (!err || typeof err !== "object") {
        return false;
    }
    return (err as any).code === code;
}

type SqliteJournalMode = "WAL" | "DELETE";
type SqliteSynchronousMode = "OFF" | "NORMAL" | "FULL" | "EXTRA";

export type SqliteRuntimePragmas = Readonly<{
    journalMode: SqliteJournalMode;
    synchronous: SqliteSynchronousMode;
    busyTimeoutMs: number;
    journalSizeLimitBytes: number;
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

export async function applySqliteRuntimePragmas(client: PrismaClientType, env: NodeJS.ProcessEnv): Promise<void> {
    const pragmas = resolveSqliteRuntimePragmasFromEnv(env);
    // These PRAGMA values come from strict allow-list / numeric-range resolvers above.
    // Keep the resolution step as the SQL safety boundary for these raw statements.
    await client.$queryRawUnsafe(`PRAGMA journal_mode=${pragmas.journalMode};`);
    await client.$queryRawUnsafe(`PRAGMA synchronous=${pragmas.synchronous};`);
    await client.$queryRawUnsafe(`PRAGMA busy_timeout=${pragmas.busyTimeoutMs};`);
    await client.$queryRawUnsafe(`PRAGMA journal_size_limit=${pragmas.journalSizeLimitBytes};`);
}

export async function shutdownDbPglite(): Promise<void> {
    if (_provider !== "pglite") {
        throw new Error(`shutdownDbPglite() called when provider is ${_provider ?? "unset"}`);
    }
    const client = _db;
    _db = null;
    _provider = null;
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
