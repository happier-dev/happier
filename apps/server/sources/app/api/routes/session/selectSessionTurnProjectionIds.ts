import { db, getActiveDbProvider } from "@/storage/db";

import {
    buildSessionTurnProjectionIdsSql,
    type SessionTurnProjectionDialect,
} from "./buildSessionTurnProjectionSql";

/**
 * Runs the turn projection and returns the ids it selected.
 *
 * Deliberately returns IDS ONLY: the caller hydrates them through the same Prisma select the
 * ordinary listing uses, so the response shape, the stored-content envelope and every mapper
 * stay untouched. The raw statement can decide WHICH rows are returned and nothing else.
 */

export function resolveSessionTurnProjectionDialect(): SessionTurnProjectionDialect | null {
    const provider = getActiveDbProvider();
    if (provider === null) return null;
    // `pglite` speaks Postgres; it needs no branch of its own.
    if (provider === "postgres" || provider === "pglite") return "postgres";
    if (provider === "sqlite") return "sqlite";
    if (provider === "mysql") return "mysql";
    return null;
}

export type SessionTurnProjectionQuery = Readonly<{
    sessionId: string;
    sidechainId: string | null;
    beforeSeq: number | null;
    /** Number of TURNS to return, not rows. */
    turnLimit: number;
}>;

export async function selectSessionTurnProjectionIds(
    query: SessionTurnProjectionQuery,
): Promise<string[]> {
    const dialect = resolveSessionTurnProjectionDialect();
    if (dialect === null) {
        throw new Error("Turn projection requested before the database provider was initialized");
    }

    const built = buildSessionTurnProjectionIdsSql({
        dialect,
        sidechainId: query.sidechainId,
        hasBeforeSeq: query.beforeSeq !== null,
    });

    const values = built.parameterOrder.map((name) => {
        switch (name) {
            case "sessionId": return query.sessionId;
            case "sidechainId": return query.sidechainId;
            case "beforeSeq": return query.beforeSeq;
            case "turnLimit": return query.turnLimit;
            case "userRole": return "user";
            case "agentRole": return "agent";
            case "toolRole": return "tool";
            default: throw new Error(`Unbound turn projection parameter: ${name}`);
        }
    });

    const rows = await db.$queryRawUnsafe<Array<{ id: unknown }>>(built.sql, ...values);
    const ids: string[] = [];
    for (const row of rows) {
        if (typeof row?.id === "string" && row.id.length > 0) ids.push(row.id);
    }
    return ids;
}
