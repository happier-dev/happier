import { Prisma, PrismaClient } from "@prisma/client";

export { Prisma };
export type TransactionClient = Prisma.TransactionClient;
export type PrismaClientType = PrismaClient;

export * from "./enums.generated";

let _db: PrismaClientType | null = null;

export const db: PrismaClientType = new Proxy({} as PrismaClientType, {
    get(_target, prop) {
        if (!_db) {
            if (prop === Symbol.toStringTag) return "PrismaClient";
            // Avoid accidental `await db` treating it like a thenable.
            if (prop === "then") return undefined;
            throw new Error("Database client is not initialized. Call initDbPostgres() or initDbSqlite() before using db.");
        }
        const value = (_db as any)[prop];
        return typeof value === "function" ? value.bind(_db) : value;
    },
    set(_target, prop, value) {
        if (!_db) {
            throw new Error("Database client is not initialized. Call initDbPostgres() or initDbSqlite() before using db.");
        }
        (_db as any)[prop] = value;
        return true;
    },
}) as PrismaClientType;

export function initDbPostgres(): void {
    _db = new PrismaClient();
}

export async function initDbSqlite(): Promise<void> {
    const clientUrl = new URL("../../generated/sqlite-client/index.js", import.meta.url);
    const mod: any = await import(clientUrl.toString());
    const SqlitePrismaClient: any = mod?.PrismaClient ?? mod?.default?.PrismaClient;
    if (!SqlitePrismaClient) {
        throw new Error("Failed to load sqlite PrismaClient (missing generated/sqlite-client)");
    }
    const client = new SqlitePrismaClient() as PrismaClientType;

    // SQLite can throw transient "database is locked" / SQLITE_BUSY under concurrent writes,
    // especially in CI where we spawn many sessions in parallel. Add a small retry layer and
    // increase busy timeout to make light/sqlite a viable test backend.
    const isSqliteBusyError = (err: unknown): boolean => {
        const message = err instanceof Error ? err.message : String(err);
        return message.includes("SQLITE_BUSY") || message.includes("database is locked");
    };

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const clientWithRetries = (client as any).$extends({
        query: {
            $allModels: {
                $allOperations: async ({
                    operation,
                    args,
                    query,
                }: {
                    operation: string;
                    args: unknown;
                    query: (args: unknown) => Promise<unknown>;
                }) => {
                    const isWrite =
                        operation === "create" ||
                        operation === "createMany" ||
                        operation === "update" ||
                        operation === "updateMany" ||
                        operation === "upsert" ||
                        operation === "delete" ||
                        operation === "deleteMany";

                    if (!isWrite) {
                        return await query(args);
                    }

                    const maxRetries = 6;
                    let attempt = 0;
                    while (true) {
                        try {
                            return await query(args);
                        } catch (e) {
                            if (!isSqliteBusyError(e) || attempt >= maxRetries) {
                                throw e;
                            }
                            const backoffMs = 25 * Math.pow(2, attempt);
                            attempt += 1;
                            await sleep(backoffMs);
                        }
                    }
                },
            },
        },
    }) as PrismaClientType;

    // These PRAGMAs are applied per connection; Prisma may use a pool, but even setting them once
    // on startup helps CI stability. We keep the connection open; shutdown handler will disconnect.
    await clientWithRetries.$connect();
    // NOTE: Some PRAGMAs (e.g. `journal_mode`) return results; use `$queryRaw*` to avoid P2010.
    await clientWithRetries.$queryRawUnsafe("PRAGMA journal_mode=WAL");
    await clientWithRetries.$queryRawUnsafe("PRAGMA busy_timeout=5000");

    _db = clientWithRetries;
}

export function isPrismaErrorCode(err: unknown, code: string): boolean {
    if (!err || typeof err !== "object") {
        return false;
    }
    return (err as any).code === code;
}
