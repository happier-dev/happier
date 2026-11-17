import type { Prisma as PrismaNamespace, PrismaClient as PrismaClientInstance } from "@prisma/client";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { DbProvider } from "@/config/databaseProvider";
import { resolveLightSqliteBusyTimeoutMsFromEnv } from "@/flavors/light/sqliteConnectionConfig";

import { createPrismaDriverAdapter, withStatementTiming, type DriverStatementObserver } from "./prismaDriverAdapters";

/**
 * Prisma client construction: the only place a server Prisma client is built (driver adapter,
 * generated provider client, pool size). `prisma.ts` owns the process-wide database lifecycle on
 * top of it and re-exports its public API; tooling that only needs a client for a URL (hstack's
 * database tasks) imports this module directly so it does not load the server graph.
 */

type PrismaClientType = PrismaClientInstance;

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

/**
 * A source tree whose node_modules belongs to another checkout generates its default client
 * run-local (apps/server/scripts/prismaInstallLayout.mjs); that client, not the other
 * checkout's, matches this tree's schema.
 */
const RUN_LOCAL_DEFAULT_CLIENT_ENTRYPOINT = fileURLToPath(new URL("../../generated/default-client/index.js", import.meta.url));

export function loadDefaultPrismaClientModule(): typeof import("@prisma/client") {
    const packaged = loadPackagedPrismaClientModule();
    if (packaged) {
        return packaged;
    }
    if (existsSync(RUN_LOCAL_DEFAULT_CLIENT_ENTRYPOINT)) {
        return requireFromHere(RUN_LOCAL_DEFAULT_CLIENT_ENTRYPOINT) as typeof import("@prisma/client");
    }
    return requireFromHere("@prisma/client") as typeof import("@prisma/client");
}

/**
 * Prisma 7 runs its query compiler in-process and reaches the database through a driver
 * adapter (`prismaDriverAdapters.ts`). The adapter is the connection pool: the URL's
 * `connection_limit` sizes it, as it sized the Rust engine's.
 */
/**
 * Construction options: Prisma's statement events (`log`), every statement the PostgreSQL driver
 * sends including transaction framing (`onDriverStatement`; cost contracts), and statement timing
 * (the runtime client's metrics).
 */
export type PrismaClientConstructionOptions = Readonly<{
    log?: DbClientLog;
    onDriverStatement?: DriverStatementObserver;
    observeStatementDurationMs?: (durationMs: number) => void;
}>;

/**
 * Query plan cache: Prisma's default (an LRU of 1000 shapes per client) is kept on measurement
 * (2026-11-17, P03-PRISMA-7-B): a server-light lifetime of startup, sign-in, 10 Session spawns and
 * N=1/N=10 turns compiles 390 distinct shapes; a cached plan costs ~7 KiB of heap; the server has
 * ~5,400 model operation call sites, so covering every cold path would cost tens of MiB per
 * process to save one ~0.5 ms recompile each. Revisit when a production lifetime's distinct-shape
 * count approaches 1000.
 */
function createPrismaClientOptions(provider: DbProvider, databaseUrl: string,
    { onDriverStatement, observeStatementDurationMs }: PrismaClientConstructionOptions): Readonly<{
    errorFormat: "minimal";
    adapter: ReturnType<typeof createPrismaDriverAdapter>["factory"];
    poolStats: ReturnType<typeof createPrismaDriverAdapter>["poolStats"];
}> {
    const driver = createPrismaDriverAdapter(provider, databaseUrl, {
        sqliteBusyTimeoutMs: resolveLightSqliteBusyTimeoutMsFromEnv(process.env),
        ...(onDriverStatement ? { onDriverStatement } : {}),
    });
    const timed = observeStatementDurationMs ? withStatementTiming(driver.factory, observeStatementDurationMs) : driver.factory;
    // Server diagnostics consume Prisma codes/messages, never source snippets.
    return { errorFormat: "minimal", adapter: timed, poolStats: driver.poolStats };
}

function requireDatabaseUrl(databaseUrl: string | undefined): string {
    const resolved = databaseUrl ?? process.env.DATABASE_URL;
    if (!resolved) throw new Error("DATABASE_URL is required to create a database client.");
    return resolved;
}

export function createDefaultPrismaClient(
    databaseUrl?: string,
    provider: 'postgres' | 'pglite' = 'postgres',
    { log, ...driverOptions }: PrismaClientConstructionOptions = {},
): Readonly<{
    client: PrismaClientType;
    poolStats: ReturnType<typeof createPrismaDriverAdapter>["poolStats"];
}> {
    applyDatabaseConnectionLimitOverride(provider);
    const { PrismaClient } = loadDefaultPrismaClientModule();
    const { poolStats, ...options } = createPrismaClientOptions(provider, requireDatabaseUrl(databaseUrl), driverOptions);
    return { client: new PrismaClient({ ...options, ...(log ? { log } : {}) }), poolStats };
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

function applyDatabaseConnectionLimitOverride(provider: DbProvider): void {
    // PGlite's resolved socket URL is a fixed single-connection resource, not an operator-sized pool.
    if (provider !== 'pglite' && process.env.DATABASE_URL) {
        process.env.DATABASE_URL = applyConfiguredDatabaseConnectionLimit(process.env.DATABASE_URL, process.env);
    }
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

export async function createGeneratedPrismaClient(
    provider: "mysql" | "sqlite",
    databaseUrl?: string,
    { log, ...driverOptions }: PrismaClientConstructionOptions = {},
): Promise<Readonly<{
    client: PrismaClientType;
    prisma: typeof import("@prisma/client").Prisma;
    poolStats: ReturnType<typeof createPrismaDriverAdapter>["poolStats"];
}>> {
    applyDatabaseConnectionLimitOverride(provider);
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
    if (!mod?.Prisma) {
        throw new Error(`Invalid generated Prisma runtime module: ${entrypoint}`);
    }
    const { poolStats, ...options } = createPrismaClientOptions(provider, requireDatabaseUrl(databaseUrl), driverOptions);
    return {
        // Generated provider clients share the repository's Prisma client contract.
        client: new mod.PrismaClient({ ...options, ...(log ? { log } : {}) }) as PrismaClientType,
        prisma: mod.Prisma as typeof import("@prisma/client").Prisma,
        poolStats,
    };
}

/** Prisma client log definitions (e.g. `{ emit: "event", level: "query" }` for statement-count tests). */
export type DbClientLog = PrismaNamespace.LogDefinition[];

/**
 * Creates an isolated migration/maintenance client without changing the
 * process-wide runtime DB owner. Deployment maintenance must release this
 * client before normal server initialization starts.
 */
export async function createDbMaintenanceClient(
    provider: DbProvider,
    databaseUrl?: string,
    options: Readonly<Pick<PrismaClientConstructionOptions, "log" | "onDriverStatement">> = {},
): Promise<PrismaClientType> {
    if (provider === "postgres" || provider === "pglite") {
        return createDefaultPrismaClient(databaseUrl, provider, options).client;
    }
    return (await createGeneratedPrismaClient(provider, databaseUrl, options)).client;
}

/** Subscribes to statement events of a client created with `log: [{ emit: "event", level: "query" }]`. */
export function onDbClientQuery(client: PrismaClientType, listener: (event: PrismaNamespace.QueryEvent) => void): void {
    // The shared client type is declared without log options, which types `$on` events as never.
    (client as unknown as { $on(event: "query", listener: (event: PrismaNamespace.QueryEvent) => void): void }).$on("query", listener);
}

export async function createDbSqliteMaintenanceClient(): Promise<PrismaClientType> {
    return (await createGeneratedPrismaClient("sqlite")).client;
}

export function withConnectionLimit(rawUrl: string, limit: number): string {
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
    if (url.protocol === "file:") {
        // Prisma accepts relative and Windows file paths that URL serialization would relocate.
        const suffixAt = rawUrl.search(/[?#]/u);
        const filePath = suffixAt < 0 ? rawUrl : rawUrl.slice(0, suffixAt);
        return `${filePath}${url.search}${url.hash}`;
    }
    return url.toString();
}
