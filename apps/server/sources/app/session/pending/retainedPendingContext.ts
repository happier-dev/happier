import type { CurrentSessionPublisherAuthority } from '@/app/presence/sessionPublisherPresence';
import { isSessionInputTargetCurrentForPublisherInTx, readStoredSessionInputAdmissionReceipt } from '@/app/session/messages/sessionInputAdmission';
import type { Tx } from '@/storage/inTx';
import { readSessionFollowWakeCoalescingSourceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';

export function readPendingFollowWakeCoalescingSource(inputAdmissionReceipt: unknown): string | undefined {
    return readSessionFollowWakeCoalescingSourceV1(readStoredSessionInputAdmissionReceipt(inputAdmissionReceipt)?.followDeliveryV1);
}

/** Claimed information may stay queued while a natural input omits it from context. */
export async function isRetainedPendingContextForPublisherInTx(
    tx: Tx,
    row: Readonly<{
        status: string;
        targetExecutionRunId: string | null;
        deliveryState: string | null;
        deliveryBlockedReason: string | null;
        inputAdmissionReceipt: unknown;
        autonomousExchangeCause: string | null;
    }>,
    publisher: CurrentSessionPublisherAuthority,
    followWakeSource?: string,
): Promise<boolean> {
    const receipt = readStoredSessionInputAdmissionReceipt(row.inputAdmissionReceipt);
    return row.status === 'queued'
        && row.targetExecutionRunId === null
        && (row.deliveryState === 'delivering' || (row.deliveryState === 'blocked'
            && row.deliveryBlockedReason === 'delivery_outcome_uncertain'))
        && (receipt?.nextTurnNote === 'file_review_note.v1'
            || receipt?.followDeliveryV1?.delivery === 'next_turn' || row.autonomousExchangeCause === 'returned_answer'
            || (followWakeSource !== undefined && row.deliveryState === 'delivering'
                && readSessionFollowWakeCoalescingSourceV1(receipt?.followDeliveryV1) === followWakeSource))
        && await isSessionInputTargetCurrentForPublisherInTx(tx, row.inputAdmissionReceipt, publisher);
}
