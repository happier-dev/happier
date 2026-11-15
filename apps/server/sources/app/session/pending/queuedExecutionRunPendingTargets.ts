import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { ExecutionRunIdSchema, SessionIdSchema } from "@happier-dev/protocol/sessions/idsV1";

export type QueuedExecutionRunPendingTarget = Readonly<{
    sessionId: string;
    runId: string;
}>;

/**
 * Current owner-scoped recipient projection of queued Execution Run targets. One owner for the
 * durable Account-change replay (`/v2/changes` hint), the Session read and the `pending-changed` push.
 */
export async function listQueuedExecutionRunPendingTargetsForSessions(params: Readonly<{
    accountId: string;
    sessionIds: readonly string[];
    reader?: Pick<Tx, "sessionPendingMessage">;
}>): Promise<QueuedExecutionRunPendingTarget[]> {
    if (typeof params.accountId !== "string" || params.accountId.length === 0) return [];
    const sessionIds = [...new Set(params.sessionIds.flatMap((value) => {
        const parsed = SessionIdSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
    }))];
    if (sessionIds.length === 0) return [];

    const rows = await (params.reader ?? db).sessionPendingMessage.findMany({
        where: {
            sessionId: { in: sessionIds },
            session: { is: { accountId: params.accountId } },
            status: "queued",
            targetExecutionRunId: { not: null },
        },
        orderBy: [
            { sessionId: "asc" },
            { position: "asc" },
        ],
        select: {
            sessionId: true,
            targetExecutionRunId: true,
        },
    });
    const seen = new Set<string>();
    return rows.flatMap((row) => {
        const runId = ExecutionRunIdSchema.safeParse(row.targetExecutionRunId);
        if (!runId.success) return [];
        const key = `${row.sessionId}\u0000${runId.data}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ sessionId: row.sessionId, runId: runId.data }];
    });
}
