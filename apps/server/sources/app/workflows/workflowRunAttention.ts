import type { Prisma } from "@prisma/client";
import { WORKFLOW_ATTENTION_INVOCATION_LIFECYCLES_V1 } from "@happier-dev/protocol/workflows/workflowProgressV1";
import { AUTOMATION_RUN_TERMINAL_STATES_V3 as AUTOMATION_RUN_TERMINAL_STATES } from "@happier-dev/protocol/automations/automationRunStateV3";
import { getDbProviderFromEnv, prismaRuntime } from "@/storage/prisma";
import type { Tx } from '@/storage/inTx';
import { db } from '@/storage/db';

/** Actual origin work, excluding attention and withdrawal-only reconciliation. */
export async function readWorkflowRunOriginWakeCandidatesInTx(tx: Tx, input:
    | Readonly<{ originSessionId: string; runId?: string }>
    | Readonly<{ accountIds: readonly string[] }>) {
    return tx.automationRun.findMany({ where: {
        ...('originSessionId' in input
            ? { originSessionId: input.originSessionId, ...(input.runId ? { id: input.runId } : {}) }
            : { accountId: { in: [...input.accountIds] }, originSessionId: { not: null } }),
        workflowCustodyState: { not: null }, workflowAcceptedSnapshotEnvelope: { not: null },
        OR: [
            { workflowInvocations: { some: { lifecycle: 'admitting' } } },
            { state: { in: [...AUTOMATION_RUN_TERMINAL_STATES] }, originDeliveryAckRevision: { not: null },
                revision: { gt: tx.automationRun.fields.originDeliveryAckRevision } },
        ],
    }, select: { id: true, accountId: true, originSessionId: true, revision: true,
        automationId: true, state: true, scheduledAt: true, startedAt: true, finishedAt: true,
        updatedAt: true, claimedByMachineId: true, attempt: true } });
}

/** Public human-attention facts; physical Stop custody has its own recovery index. */
const attention = {
    cancelled: "cancelled",
    failed: "failed",
    invocations: WORKFLOW_ATTENTION_INVOCATION_LIFECYCLES_V1,
} as const;

export function workflowRunFailureUnseen(input: Readonly<{
    accountId: string; state: string; finishedAt: Date | null; attentionSeenFailureAt: Date | null;
}>, viewerAccountId: string): boolean {
    return input.accountId === viewerAccountId && input.state === attention.failed
        && (input.attentionSeenFailureAt === null
            || input.finishedAt !== null && input.finishedAt > input.attentionSeenFailureAt);
}

export function workflowRunAttentionWhere(viewerAccountId: string): Prisma.AutomationRunWhereInput {
    return {
        state: { not: attention.cancelled },
        // A failed Run can have no Session or actionable invocation to surface it.
        // Accepted Automation Runs use this owner too, never ordinary attention.
        OR: [
            { accountId: viewerAccountId, state: attention.failed, OR: [
                { attentionSeenFailureAt: null },
                { finishedAt: { gt: db.automationRun.fields.attentionSeenFailureAt } },
            ] },
            { workflowInvocations: { some: { lifecycle: { in: [...attention.invocations] } } } },
        ],
    };
}

/** Exact page/control facts, using the same invocation index as attention membership. No content or history. */
export async function readWorkflowRunInvocationAttentionInTx(tx: Pick<Tx, 'workflowRunInvocation'>, runIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (runIds.length === 0) return new Set();
    const rows = await tx.workflowRunInvocation.groupBy({ by: ['runId'],
        where: { runId: { in: [...runIds] }, lifecycle: { in: [...attention.invocations] } } });
    return new Set(rows.map(row => row.runId));
}

/** Identifiers are owner-authored, never caller input; values stay bound parameters. */
export function workflowRunSqlIdentifier(name: string): Prisma.Sql {
    const quote = getDbProviderFromEnv(process.env, "postgres") === "mysql" ? "`" : '"';
    return prismaRuntime.raw(`${quote}${name}${quote}`);
}

/** SQL projection of the same facts for the single batched summary query. */
export function workflowRunFailureUnseenSql(viewerAccountId: string): Prisma.Sql {
    const id = workflowRunSqlIdentifier;
    const textType = prismaRuntime.raw(getDbProviderFromEnv(process.env, "postgres") === "mysql" ? "CHAR" : "TEXT");
    return prismaRuntime.sql`(r.${id("accountId")} = ${viewerAccountId} AND CAST(r.${id("state")} AS ${textType}) = ${attention.failed}
        AND (r.${id("attentionSeenFailureAt")} IS NULL OR r.${id("finishedAt")} > r.${id("attentionSeenFailureAt")}))`;
}

export function workflowRunInvocationAttentionSql(): Prisma.Sql {
    const id = workflowRunSqlIdentifier;
    const textType = prismaRuntime.raw(getDbProviderFromEnv(process.env, "postgres") === "mysql" ? "CHAR" : "TEXT");
    return prismaRuntime.sql`(CAST(r.${id("state")} AS ${textType}) <> ${attention.cancelled}
        AND EXISTS (SELECT 1 FROM ${id("WorkflowRunInvocation")} i WHERE i.${id("runId")} = r.${id("id")} AND CAST(i.${id("lifecycle")} AS ${textType}) IN (${prismaRuntime.join([...attention.invocations])})))`;
}

export function workflowRunAttentionSql(viewerAccountId: string): Prisma.Sql {
    return prismaRuntime.sql`(${workflowRunFailureUnseenSql(viewerAccountId)} OR ${workflowRunInvocationAttentionSql()})`;
}
