import { readNativeCredentialPolicyPublicationAccountIdsInTx } from '@/app/teams/credentials/nativePolicyChanges';
import { afterTx, inTx, type Tx } from '@/storage/inTx';
import type { Prisma } from '@prisma/client';
import { log } from '@/utils/logging/log';
import { acquireAccountChangePublicationLocksInTx, markAccountsChanged, type AccountChangePublication } from '@/app/changes/markAccountChanged';
import { tombstoneSessionDraftForLifecycleInTx } from '@/app/account/sessionDrafts/sessionDraftService';
import { SessionDeletedChangeHintV1Schema } from '@happier-dev/protocol/changes';
import { resolveCurrentSessionRecipientAccountIdsBySessionInTx, resolveSessionGrantedAccountIdsInTx } from '@/app/session/access/sessionRecipients';
import { deleteAutomationTx } from '@/app/automations/automationCrudService';
import { acquireSessionAccountCursorLocksInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';
import { hasSessionFollowSessionSource } from '@/app/session/follow/sessionFollowSourceIdentity';
import { publishSessionProviderBrokerConsumersChangedInTx } from '@/app/providers/brokerConsumerChanges';

import { deleteSessionTree, SessionDeleteConditionLostError } from './deleteSessionTree';
import { emitSessionDeletedUpdate } from './emitSessionDeletedUpdate';
import { loadSessionDeleteRecipients } from './loadSessionDeleteRecipients';

/**
 * Deletion outcomes are kept apart because callers act on them differently.
 *
 * - `not-found`: the session is absent, or not owned by / not reachable for the
 *   caller under the supplied guard. The row this caller could delete does not
 *   exist, so a client may safely retire its own copy of it.
 * - `conflict`: the session WAS found, but the guarded delete lost its condition
 *   between the read and the write (a concurrent metadata write, or a retention
 *   guard that stopped matching). Nothing was deleted and the row still exists,
 *   so this is retryable and must never be read as "already gone".
 * - `active`: a caller initiated deletion before stopping the Session. Nothing
 *   was deleted; the caller must stop the Session before requesting deletion.
 */
export type DeleteOwnedSessionResult =
    | Readonly<{ ok: true }>
    | Readonly<{
        ok: false;
        error: 'not-found' | 'conflict' | 'active';
    }>;

type DeleteOwnedSessionCommonParams = Readonly<{
    sessionId: string;
    sessionWhereGuard?: Prisma.SessionWhereInput;
}>;

export type DeleteOwnedSessionParams =
    | (DeleteOwnedSessionCommonParams & Readonly<{
        reason: 'user_request';
        ownerAccountId: string;
    }>)
    | (DeleteOwnedSessionCommonParams & Readonly<{
        reason: 'retention_policy';
        ownerAccountId?: string | null;
    }>);

export async function deleteOwnedSession(
    params: DeleteOwnedSessionParams,
): Promise<DeleteOwnedSessionResult> {
    try {
        return await inTx(async (tx) => {
            await acquireSessionAccountCursorLocksInTx(
                tx,
                [params.sessionId],
                params.ownerAccountId ? [params.ownerAccountId] : [],
                { includeLifecyclePublications: true },
            );
            return await deleteSessionWithRecipientsInTx(tx, params);
        }, {
            isolationLevel: 'ReadCommitted',
            transactionClass: 'session-delete',
        });
    } catch (error) {
        if (error instanceof SessionDeleteConditionLostError) {
            return { ok: false, error: 'conflict' };
        }
        throw error;
    }
}

/**
 * The guarded Session-deletion lifecycle for an existing transaction. Account
 * erasure composes it before deleting the Account, so recipient capture, drafts,
 * durable changes, and after-commit events have the same owner as ordinary delete.
 * A lost write condition must escape and roll back the caller's transaction.
 */
export async function deleteSessionWithRecipientsInTx(
    tx: Tx,
    params: DeleteOwnedSessionParams,
): Promise<DeleteOwnedSessionResult> {
    const session = await loadSessionDeleteRecipients(tx, {
        sessionId: params.sessionId,
        ownerAccountId: params.ownerAccountId ?? null,
        sessionWhereGuard: params.sessionWhereGuard,
    });

    if (!session) {
        log(
            { module: 'session-delete', userId: params.ownerAccountId ?? null, sessionId: params.sessionId, reason: params.reason },
            'Session not found or not owned by user',
        );
        return { ok: false, error: 'not-found' } as const;
    }

    const isCallerInitiated = params.reason === 'user_request';
    if (isCallerInitiated && session.active) {
        return { ok: false, error: 'active' } as const;
    }

    // Resolve recipients before the row disappears, and resolve them through
    // the canonical access owner so a Team- or Group-granted collaborator
    // receives the same draft tombstone and deletion projection a direct
    // recipient does. Transcript publication does not narrow this set: a
    // collaborator who cannot receive content still has a local Session row
    // that must be retired.
    const recipientAccountIds = new Set<string>(
        await resolveSessionGrantedAccountIdsInTx(tx, { sessionId: params.sessionId }),
    );
    recipientAccountIds.add(session.accountId);

    const [followEdges, managerEdges, runnerActivation] = await Promise.all([
        tx.sessionFollowEdge.findMany({ where: { sourceSessionId: params.sessionId }, select: { destinationSessionId: true } }),
        tx.sessionFollowEdge.findMany({ where: { relation: 'manager', OR: [{ sourceSessionId: params.sessionId }, { destinationSessionId: params.sessionId }] },
            select: { sourceSessionId: true, destinationSessionId: true } }),
        tx.ephemeralRunnerActivation.findFirst({ where: { sessionId: params.sessionId, state: 'materialized' }, select: { creatorAccountId: true } }),
    ]);
    const relationRecipients = await resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, { sessionIds: [
        ...followEdges.map(edge => edge.destinationSessionId), ...managerEdges.filter(hasSessionFollowSessionSource).flatMap(edge => [edge.sourceSessionId, edge.destinationSessionId]),
    ] });
    await acquireAccountChangePublicationLocksInTx(tx, [...recipientAccountIds, ...[...relationRecipients.values()].flat(),
        ...await readNativeCredentialPolicyPublicationAccountIdsInTx(tx, { sessionIds: [params.sessionId] }),
        ...(runnerActivation ? [runnerActivation.creatorAccountId] : [])]);

    const sessionDeleteWhere = {
        ...(params.sessionWhereGuard ?? {}),
        ...(params.ownerAccountId ? { accountId: params.ownerAccountId } : {}),
        ...(isCallerInitiated
            ? {
                active: false,
                metadataLayoutVersion:
                    session.metadataLayoutVersion,
            }
            : null),
    };
    const recipientCursors: AccountChangePublication[] = [];
    const deletionHint = SessionDeletedChangeHintV1Schema.parse({
        v: 1,
        lifecycle: 'deleted',
    });
    for (const accountId of recipientAccountIds) {
        await tombstoneSessionDraftForLifecycleInTx(tx, {
            accountId,
            sessionId: params.sessionId,
        });
    }
    const scopedAutomations = await tx.automation.findMany({
        where: { accountId: session.accountId, scopeSessionId: params.sessionId, deletedAt: null },
        select: { id: true }, orderBy: { id: 'asc' },
    });
    for (const automation of scopedAutomations) {
        if (!await deleteAutomationTx(tx, { accountId: session.accountId, automationId: automation.id })) {
            throw new Error('Scoped Automation could not be retired during Session deletion');
        }
    }
    const deleted = await deleteSessionTree(tx, {
        sessionId: params.sessionId,
        sessionUpdatedAt: session.updatedAt,
        actorAccountId: session.accountId,
        reason: params.reason,
        sessionDeleteWhere: Object.keys(sessionDeleteWhere).length > 0 ? sessionDeleteWhere : undefined,
        afterSessionWriteBoundary: async () => {
            await publishSessionProviderBrokerConsumersChangedInTx(tx, params.sessionId);
            recipientCursors.push(...await markAccountsChanged(tx, { accountIds: [...recipientAccountIds],
                kind: 'session', entityId: params.sessionId, hint: deletionHint }));
        },
    });

    afterTx(tx, () => {
        log(
            {
                module: 'session-delete',
                userId: session.accountId,
                sessionId: params.sessionId,
                reason: params.reason,
                deletedMessages: deleted.deletedMessages,
                deletedReports: deleted.deletedReports,
                deletedAccessKeys: deleted.deletedAccessKeys,
            },
            'Session deleted successfully',
        );
        void Promise.all(recipientCursors.map(publication =>
            emitSessionDeletedUpdate({
                sessionId: params.sessionId,
                accountId: publication.accountId,
                cursor: publication.resolveCursor(),
            }),
        )).catch((error: unknown) => {
            log(
                {
                    module: 'session-delete',
                    userId: session.accountId,
                    sessionId: params.sessionId,
                    reason: params.reason,
                    error,
                },
                'Failed to emit one or more delete-session updates',
            );
        });
    });

    return { ok: true } as const;
}
