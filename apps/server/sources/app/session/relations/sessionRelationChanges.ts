import { afterTx, type Tx } from '@/storage/inTx';
import { resolveCurrentSessionRecipientAccountIdsBySessionInTx } from '@/app/session/access/sessionRecipients';
import { markSessionAccountsChanged, type AccountChangePublication } from '@/app/changes/markAccountChanged';
import { eventRouter } from '@/app/events/eventRouter';
import { randomKeyNaked } from '@/utils/keys/randomKeyNaked';
import { markSessionFollowReceiversChangedInTx } from '@/app/session/follow/changes';

/** Content-free relation changes use the same AccountChange and committed socket hint. */
export function scheduleSessionRelationBroadcastAfterTx(tx: Tx, sessionId: string, accountIds: readonly string[]): void {
    const recipients = [...new Set(accountIds)].sort();
    if (recipients.length === 0) return;
    const payload = { id: randomKeyNaked(12), createdAt: Date.now(), body: { t: 'session-changed' as const, sessionId } };
    afterTx(tx, () => {
        for (const userId of recipients) void eventRouter.emitSessionBroadcast({ userId, sessionId, payload });
    });
}

export async function invalidateSessionRelationProjectionsInTx(
    tx: Tx,
    sessionIds: Iterable<string>,
    resolvedRecipients?: ReadonlyMap<string, readonly string[]>,
): Promise<AccountChangePublication[]> {
    const uniqueSessionIds = [...new Set(sessionIds)].sort();
    const recipientsBySession = resolvedRecipients
        ?? await resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, { sessionIds: uniqueSessionIds });
    const publications = await markSessionAccountsChanged(tx, recipientsBySession);
    await markSessionFollowReceiversChangedInTx(tx, recipientsBySession);
    for (const [sessionId, accountIds] of recipientsBySession) {
        scheduleSessionRelationBroadcastAfterTx(tx, sessionId, accountIds);
    }
    return publications;
}
