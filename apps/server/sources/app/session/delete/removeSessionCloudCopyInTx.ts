import type { Prisma } from '@prisma/client';
import { SessionDeletedChangeHintV1Schema } from '@happier-dev/protocol/changes';

import { tombstoneSessionDraftForLifecycleInTx } from '@/app/account/sessionDrafts/sessionDraftService';
import { deleteAutomationTx } from '@/app/automations/automationCrudService';
import { markAccountChanged, markAccountsChanged } from '@/app/changes/markAccountChanged';
import { eventRouter, buildUpdateSessionUpdate } from '@/app/events/eventRouter';
import { resolveSessionGrantedAccountIdsInTx } from '@/app/session/access/sessionRecipients';
import { acquireSessionAccountCursorLocksInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';
import { invalidateSessionFollowDestinationsForSessionDeleteInTx } from '@/app/session/follow/sessionFollowEdgeService';
import { invalidateSessionManagerForSessionDeleteInTx } from '@/app/session/follow/sessionManagerService';
import { notifySessionHumanPresenceAccessChanged } from '@/app/session/humanPresence/sessionHumanPresenceService';
import { publishSessionAfterCommit } from '@/app/session/publishSessionAfterCommit';
import { notifySessionTranscriptMutationAfterCommit } from '@/app/session/sessionTranscriptMutationObserver';
import { publishSessionProviderBrokerConsumersChangedInTx } from '@/app/providers/brokerConsumerChanges';
import { publishNativeCredentialPolicyChangesInTx } from '@/app/teams/credentials/nativePolicyChanges';
import { afterTx, type Tx } from '@/storage/inTx';
import { randomKeyNaked } from '@/utils/keys/randomKeyNaked';

import { deleteSessionTranscriptChildren } from './deleteSessionTree';
import { emitSessionDeletedUpdate } from './emitSessionDeletedUpdate';

export async function removeSessionCloudCopyInTx(tx: Tx, params: {
    sessionId: string;
    eligible: Prisma.SessionWhereInput;
    now: Date;
}): Promise<boolean> {
    const { sessionId, eligible, now } = params;
    const accountIds = await resolveSessionGrantedAccountIdsInTx(tx, { sessionId });
    await acquireSessionAccountCursorLocksInTx(tx, [sessionId], accountIds, { includeLifecyclePublications: true });
    const where = { AND: [{ id: sessionId }, eligible] };
    const row = await tx.session.findFirst({
        where,
        select: { accountId: true, seq: true, updatedAt: true, agentStateVersion: true },
    });
    if (!row) return false;

    const projection = {
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
        pendingRequestObservedAt: null,
        latestReadyEventSeq: null,
        latestReadyEventAt: null,
        latestTurnId: null,
        latestTurnStatus: null,
        latestTurnStatusObservedAt: null,
    };
    const { count } = await tx.session.updateMany({
        where,
        data: {
            ...projection,
            updatedAt: row.updatedAt,
            cloudCopyLeftAt: now,
            currentStorageState: 'machine_only',
            acceptedThroughServerSeq: null,
            materializationPublicationId: null,
            materializedThroughSourceAt: null,
            publishedThroughServerSeq: null,
            agentState: null,
            agentStateBytes: null,
            agentStateVersion: { increment: 1 },
            unreadSince: null,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: { increment: 1 },
        },
    });
    if (count !== 1) return false;

    await publishNativeCredentialPolicyChangesInTx(tx, { sessionIds: [sessionId] });
    await publishSessionProviderBrokerConsumersChangedInTx(tx, sessionId);
    await deleteSessionTranscriptChildren(tx, sessionId);
    const child = { sessionId };
    await tx.sessionTurn.deleteMany({ where: child });
    await tx.sessionTurnMutationReceipt.deleteMany({ where: child });
    await tx.sessionSystemRecord.deleteMany({ where: child });
    await tx.sessionPendingMessage.deleteMany({ where: child });
    await tx.sessionGrant.deleteMany({ where: child });
    await tx.sessionDataKeyEnvelope.deleteMany({ where: { sessionId, recipientAccountId: { not: row.accountId } } });
    await tx.publicSessionShare.deleteMany({ where: child });
    await invalidateSessionFollowDestinationsForSessionDeleteInTx(tx, { sessionId });
    await invalidateSessionManagerForSessionDeleteInTx(tx, { sessionId });

    const scopedAutomations = await tx.automation.findMany({
        where: { accountId: row.accountId, scopeSessionId: sessionId, deletedAt: null },
        select: { id: true },
        orderBy: { id: 'asc' },
    });
    for (const automation of scopedAutomations) {
        if (!await deleteAutomationTx(tx, { accountId: row.accountId, automationId: automation.id })) {
            throw new Error('Scoped Automation could not be retired during cloud copy removal');
        }
    }

    const owner = await markAccountChanged(tx, { accountId: row.accountId, kind: 'session', entityId: sessionId });
    const sharees = accountIds.filter(accountId => accountId !== row.accountId);
    for (const accountId of sharees) await tombstoneSessionDraftForLifecycleInTx(tx, { accountId, sessionId });
    const deleted = await markAccountsChanged(tx, {
        accountIds: sharees, kind: 'session', entityId: sessionId,
        hint: SessionDeletedChangeHintV1Schema.parse({ v: 1, lifecycle: 'deleted' }),
    });
    notifySessionTranscriptMutationAfterCommit(tx, { kind: 'remove-session', sessionId });

    afterTx(tx, () => {
        notifySessionHumanPresenceAccessChanged({ sessionId });
        void publishSessionAfterCommit(sessionId, 'Remove Session cloud copy', async () => {
            await eventRouter.emitUpdate({
                userId: row.accountId,
                payload: buildUpdateSessionUpdate(sessionId, owner.resolveCursor(), randomKeyNaked(12), undefined, {
                    value: null, version: row.agentStateVersion + 1,
                }, { ...projection, currentStorageState: 'machine_only' }),
                recipientFilter: { type: 'user-scoped-only' },
            });
            await Promise.all(deleted.map(publication => emitSessionDeletedUpdate({
                sessionId, accountId: publication.accountId, cursor: publication.resolveCursor(),
            })));
        });
    });
    return true;
}
