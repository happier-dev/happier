import type { DriverStatement, DriverStatementObserver } from "@/storage/prismaDriverAdapters";

/** A statement as PostgreSQL received it, with its parameters as JSON (the shape Prisma's query events had). */
export type DriverStatementEvent = Readonly<{ query: string; params: string }>;

/**
 * Statement-cost contracts observe the driver, not Prisma's query log: Prisma 7's log omits the
 * transaction framing (BEGIN, SET TRANSACTION) its driver adapter sends. Pass the result as
 * `createDbMaintenanceClient(provider, url, { onDriverStatement })`.
 */
export function recordDriverStatements(listener: (statement: DriverStatementEvent) => void): DriverStatementObserver {
    return (statement: DriverStatement) => listener({
        query: statement.query,
        params: JSON.stringify(statement.params, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value),
    });
}
