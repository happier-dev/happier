import { TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";
import { acquireSessionAccountCursorLocksInTx, readSessionAccountCursorAudienceInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { assertAccountChangePublicationAudienceInTx, beforeAccountChangePublication } from "@/app/changes/markAccountChanged";
import type { AccountAdmissionIntent } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { getWorkflowPublicationAudienceInTx, type WorkflowPublicationScope } from "./workflowPublicationAudience";
import { acquireDiscussionMutationAccountsInTx } from '@/app/discussions/access';

/** Acquire the composed union before any owner mode, Run, trigger or Session write fence. */
export async function acquireWorkflowPublicationLocksInTx(
    tx: Tx,
    scope: WorkflowPublicationScope,
    options?: Readonly<{ intent?: AccountAdmissionIntent }>,
): Promise<void> {
    if (getDbProviderFromEnv(process.env, "postgres") === "sqlite") {
        if (scope.discussionId) await acquireDiscussionMutationAccountsInTx(tx, { discussionId: scope.discussionId, actorAccountId: scope.accountId });
        return;
    }
    const captured = await getWorkflowPublicationAudienceInTx(tx, scope);
    if (scope.discussionId) await acquireDiscussionMutationAccountsInTx(tx, {
        discussionId: scope.discussionId, actorAccountId: scope.accountId,
        additionalAccountIds: captured.accountIds, additionalSessionIds: captured.sessionIds,
    });
    const admittedAccountIds = await acquireSessionAccountCursorLocksInTx(tx, captured.sessionIds, captured.accountIds, options);
    if (captured.runIds.length > 0) {
        if (getDbProviderFromEnv(process.env, "postgres") === "postgres") {
            await tx.$queryRawUnsafe(
                'SELECT "id" FROM "AutomationRun" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR NO KEY UPDATE',
                captured.runIds,
            );
        } else {
            await tx.$queryRawUnsafe(
                `SELECT \`id\` FROM \`AutomationRun\` WHERE \`id\` IN (${captured.runIds.map(() => "?").join(", ")}) ORDER BY \`id\` FOR UPDATE`,
                ...captured.runIds,
            );
        }
    }
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
