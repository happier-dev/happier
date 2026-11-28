import { invalidateSessionRelayAuthorizationForSession } from '@/app/api/socket/sessionRelayAuthCache';
import { tombstoneSessionDraftForLifecycleInTx } from '@/app/account/sessionDrafts/sessionDraftService';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { buildUpdateSessionUpdate, eventRouter } from '@/app/events/eventRouter';
import type { RetentionSessionWhere } from '@/app/retention/retentionEligibleSessionWhere';
import { afterTx, type Tx } from '@/storage/inTx';
import { randomKeyNaked } from '@/utils/keys/randomKeyNaked';

import { deleteSessionTranscriptChildren } from './deleteSessionTree';
import { emitSessionDeletedUpdate } from './emitSessionDeletedUpdate';
import { loadSessionDeleteRecipients } from './loadSessionDeleteRecipients';

export async function removeSessionCloudCopyInTx(tx: Tx, params: {
    sessionId: string;
    eligible: RetentionSessionWhere;
    now: Date;
}): Promise<boolean> {
    const { sessionId, eligible, now } = params;
    const row = await tx.session.findFirst({
        where: { id: sessionId, AND: [eligible] },
        select: { seq: true, updatedAt: true, agentStateVersion: true },
    });
    if (!row) return false;

    const projection = {
        lastViewedSessionSeq: row.seq,
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
        where: {
            id: sessionId,
            seq: row.seq,
            updatedAt: row.updatedAt,
            agentStateVersion: row.agentStateVersion,
            AND: [eligible],
        },
        data: {
            ...projection,
            updatedAt: row.updatedAt,
            cloudCopyLeftAt: now,
            agentState: null,
            agentStateVersion: { increment: 1 },
            unreadSince: null,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: { increment: 1 },
        },
    });
    if (count !== 1) return false;

    const recipient = await loadSessionDeleteRecipients(tx, { sessionId });
    if (!recipient) throw new Error('Claimed session disappeared during cloud copy removal');

    await deleteSessionTranscriptChildren(tx, sessionId);
    const where = { sessionId };
    await tx.sessionTurn.deleteMany({ where });
    await tx.sessionTurnMutationReceipt.deleteMany({ where });
    await tx.sessionSystemRecord.deleteMany({ where });
    await tx.sessionPendingMessage.deleteMany({ where });
    await tx.sessionShare.deleteMany({ where });
    await tx.publicSessionShare.deleteMany({ where });

    const ownerCursor = await markAccountChanged(tx, { accountId: recipient.accountId, kind: 'session', entityId: sessionId });
    const sharees = new Map<string, number>();
    for (const { sharedWithUserId: accountId } of recipient.shares) {
        if (accountId === recipient.accountId) continue;
        sharees.set(accountId, await markAccountChanged(tx, {
            accountId, kind: 'session', entityId: sessionId, hint: { deleted: true },
        }));
        await tombstoneSessionDraftForLifecycleInTx(tx, { accountId, sessionId });
    }

    afterTx(tx, async () => {
        invalidateSessionRelayAuthorizationForSession(sessionId);
        eventRouter.emitUpdate({
            userId: recipient.accountId,
            payload: buildUpdateSessionUpdate(sessionId, ownerCursor, randomKeyNaked(12), undefined, {
                value: null,
                version: row.agentStateVersion + 1,
            }, { ...projection, cloudCopyLeftAt: now.getTime() }),
            recipientFilter: { type: 'all-interested-in-session', sessionId },
        });
        await Promise.all(Array.from(sharees, ([accountId, cursor]) =>
            emitSessionDeletedUpdate({ sessionId, accountId, cursor }),
        ));
    });
    return true;
}
