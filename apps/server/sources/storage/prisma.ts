import { Prisma, PrismaClient } from "@prisma/client";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export { Prisma };
export type TransactionClient = Prisma.TransactionClient;
export type PrismaClientType = PrismaClient;

export * from "./enums.generated";

let _db: PrismaClientType | null = null;
let _pglite: PGlite | null = null;
let _pgliteServer: PGLiteSocketServer | null = null;

export const db: PrismaClientType = new Proxy({} as PrismaClientType, {
    get(_target, prop) {
        if (!_db) {
            if (prop === Symbol.toStringTag) return "PrismaClient";
            // Avoid accidental `await db` treating it like a thenable.
            if (prop === "then") return undefined;
            throw new Error("Database client is not initialized. Call initDbPostgres() or initDbPglite() before using db.");
        }
        const value = (_db as any)[prop];
        return typeof value === "function" ? value.bind(_db) : value;
    },
    set(_target, prop, value) {
        if (!_db) {
            throw new Error("Database client is not initialized. Call initDbPostgres() or initDbPglite() before using db.");
        }
        (_db as any)[prop] = value;
        return true;
    },
}) as PrismaClientType;

export function initDbPostgres(): void {
    _db = new PrismaClient();
}

function resolveLightPgliteDirFromEnv(env: NodeJS.ProcessEnv): string {
    const fromEnv = env.HAPPY_SERVER_LIGHT_DB_DIR?.trim();
    if (fromEnv) return fromEnv;

    const dataDir = env.HAPPY_SERVER_LIGHT_DATA_DIR?.trim();
    if (!dataDir) {
        throw new Error("Missing HAPPY_SERVER_LIGHT_DATA_DIR (expected applyLightDefaultEnv to set it)");
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

    const dbDir = resolveLightPgliteDirFromEnv(process.env);
    await mkdir(dbDir, { recursive: true });

    const pglite = new PGlite(dbDir);
    // `PGlite` initializes asynchronously. Ensure it's ready before starting the socket server.
    await (pglite as any).waitReady;
    const server = new PGLiteSocketServer({
        db: pglite,
        host: "127.0.0.1",
        port: 0,
    });
    await server.start();

    // The Socket server returns a Postgres connection string. Ensure Prisma uses a single connection
    // because pglite is single-connection.
    process.env.DATABASE_URL = withConnectionLimit(server.getServerConn(), 1);

    _pglite = pglite;
    _pgliteServer = server;
    _db = new PrismaClient();
}

export function isPrismaErrorCode(err: unknown, code: string): boolean {
    if (!err || typeof err !== "object") {
        return false;
    }
    return (err as any).code === code;
}

export async function shutdownDbPglite(): Promise<void> {
    const client = _db;
    _db = null;
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
}
