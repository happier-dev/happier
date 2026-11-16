import type { Tx } from '@/storage/inTx';
import { markSessionProjectionRecipientsChanged } from '@/app/session/changeTracking/markSessionProjectionRecipientsChanged';
import { scheduleSessionRelationBroadcastAfterTx } from '@/app/session/relations/sessionRelationChanges';
import type { CauseRow } from './automationRunCauseCodec';

/** Publication acquisition and invalidation consume the changed Run's immutable cause. */
export function getSessionReviewProjectionIdForRun(run: Pick<CauseRow,
    'causeTriggerKind' | 'causeSessionLifecycleEvent' | 'causeSourceSessionId'>): string | null {
    return run.causeTriggerKind === 'sessionLifecycle'
        && (run.causeSessionLifecycleEvent === 'parentTurnCompleted'
            || run.causeSessionLifecycleEvent === 'parentTurnFailed'
            || run.causeSessionLifecycleEvent === 'parentTurnCancelled')
        ? run.causeSourceSessionId : null;
}

/** Run lifecycle changes release the review barrier through incumbent Session hints. */
export async function invalidateSessionReviewProjectionForRunInTx(tx: Tx,
    run: Parameters<typeof getSessionReviewProjectionIdForRun>[0]): Promise<void> {
    const sourceSessionId = getSessionReviewProjectionIdForRun(run);
    if (sourceSessionId === null) return;
    // The review barrier touches no Memory input (transcript seq, owner locality, archive, access).
    const recipients = await markSessionProjectionRecipientsChanged({ tx, sessionId: sourceSessionId, memoryInputsChanged: false });
    scheduleSessionRelationBroadcastAfterTx(tx, sourceSessionId, recipients.map(({ accountId }) => accountId));
}
