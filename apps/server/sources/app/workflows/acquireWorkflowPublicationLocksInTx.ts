import { TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";
import { resolveDbSqlDialect } from "@/config/databaseProvider";
import { acquireSessionAccountCursorLocksInTx, readSessionAccountCursorAudienceInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { acquireAccountChangePublicationLocksInTx, assertAccountChangePublicationAudienceInTx, beforeAccountChangePublication } from "@/app/changes/markAccountChanged";
import type { AccountAdmissionIntent } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { getWorkflowPublicationAudienceInTx, type WorkflowPublicationScope } from "./workflowPublicationAudience";
import { acquireDiscussionMutationAccountsInTx } from '@/app/discussions/access';

async function lockWorkflowRunRowsInTx(tx: Tx, runIds: readonly string[], dialect: ReturnType<typeof resolveDbSqlDialect>): Promise<void> {
    if (runIds.length === 0) return;
    if (dialect === "postgres") {
        await tx.$queryRawUnsafe(
            'SELECT "id" FROM "AutomationRun" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR NO KEY UPDATE',
            runIds,
        );
    } else {
        await tx.$queryRawUnsafe(
            `SELECT \`id\` FROM \`AutomationRun\` WHERE \`id\` IN (${runIds.map(() => "?").join(", ")}) ORDER BY \`id\` FOR UPDATE`,
            ...runIds,
        );
    }
}

/** Failure acknowledgement publishes to its owner and shares the existing Account-before-Run order. */
export async function acquireWorkflowRunOwnerPublicationLocksInTx(tx: Tx, scope: Readonly<{ accountId: string; runId: string }>): Promise<void> {
    const provider = getDbProviderFromEnv(process.env, "postgres");
    if (provider === "sqlite") return;
    await acquireAccountChangePublicationLocksInTx(tx, [scope.accountId]);
    await lockWorkflowRunRowsInTx(tx, [scope.runId], resolveDbSqlDialect(provider));
}

/** Acquire the composed union before any owner mode, Run, trigger or Session write fence. */
export async function acquireWorkflowPublicationLocksInTx(
    tx: Tx,
    scope: WorkflowPublicationScope,
    options?: Readonly<{ intent?: AccountAdmissionIntent }>,
): Promise<void> {
    const provider = getDbProviderFromEnv(process.env, "postgres");
    if (provider === "sqlite") {
        if (scope.discussionId) await acquireDiscussionMutationAccountsInTx(tx, { discussionId: scope.discussionId, actorAccountId: scope.accountId });
        return;
    }
    const captured = await getWorkflowPublicationAudienceInTx(tx, scope);
    if (scope.discussionId) await acquireDiscussionMutationAccountsInTx(tx, {
        discussionId: scope.discussionId, actorAccountId: scope.accountId,
        additionalAccountIds: captured.accountIds, additionalSessionIds: captured.sessionIds,
    });
    const admittedAccountIds = await acquireSessionAccountCursorLocksInTx(tx, captured.sessionIds, captured.accountIds, options);
    await lockWorkflowRunRowsInTx(tx, captured.runIds, resolveDbSqlDialect(provider));
    const current = await getWorkflowPublicationAudienceInTx(tx, scope);
    const accounts = new Set(captured.accountIds);
    const sessions = new Set(captured.sessionIds);
    const runs = new Set(captured.runIds);
    if (current.accountIds.some(accountId => !accounts.has(accountId))
        || current.sessionIds.some(sessionId => !sessions.has(sessionId))
        || current.runIds.some(runId => !runs.has(runId))) {
        throw new TransactionReplayRequiredError("transaction-account-audience-changed");
    }
    beforeAccountChangePublication(tx, admittedAccountIds, async client => {
        const current = await getWorkflowPublicationAudienceInTx(client, scope);
        const audience = await readSessionAccountCursorAudienceInTx(client, current.sessionIds, current.accountIds);
        // This transaction may create Sessions within its admitted Accounts.
        // Only Account growth changes the terminal publication lock set.
        assertAccountChangePublicationAudienceInTx(client, audience.accountIds);
    });
}
