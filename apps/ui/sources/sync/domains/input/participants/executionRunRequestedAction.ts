import {
    DEFAULT_PENDING_REQUESTED_ACTION_V1,
    PendingRequestedActionV1Schema,
    type PendingRequestedActionV1,
} from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';

/**
 * Reads the canonical requested action stored by current composers. Invalid or
 * absent draft values use the canonical Pending default; obsolete delivery
 * policy is never approximated through a compatibility translation.
 */
export function readExecutionRunRequestedAction(
    value: unknown,
): PendingRequestedActionV1 {
    const current = PendingRequestedActionV1Schema.safeParse(value);
    if (current.success) return current.data;
    return DEFAULT_PENDING_REQUESTED_ACTION_V1;
}
