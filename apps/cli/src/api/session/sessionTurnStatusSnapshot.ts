import type { PrimaryTurnStatusV1, SessionTurnMutationV1 } from '@happier-dev/protocol';

export type LatestTurnStatusSnapshot = PrimaryTurnStatusV1 | null;

export function readLatestTurnStatusSnapshot(value: unknown): LatestTurnStatusSnapshot | undefined {
    if (value === null) return null;
    if (
        value === 'in_progress'
        || value === 'completed'
        || value === 'failed'
        || value === 'cancelled'
    ) {
        return value;
    }
    return undefined;
}

export function isActiveLatestTurnStatus(status: LatestTurnStatusSnapshot | undefined): boolean {
    return status === 'in_progress';
}

type SessionTurnMutationAction = SessionTurnMutationV1['action'];

/**
 * Map a locally enqueued canonical turn mutation onto the latest-turn-status snapshot.
 * Keeps the cached snapshot truthful when turns begin/end through the canonical local
 * lifecycle (instead of waiting on the server snapshot echo), so a stale 'in_progress'
 * snapshot cannot keep blocking pending-queue materialization after the turn ended.
 */
export function latestTurnStatusForSessionTurnMutationAction(
    action: SessionTurnMutationAction,
): PrimaryTurnStatusV1 | undefined {
    if (action === 'begin') return 'in_progress';
    if (action === 'touch_active') return 'in_progress';
    if (action === 'complete') return 'completed';
    if (action === 'fail') return 'failed';
    if (action === 'cancel' || action === 'end_session') return 'cancelled';
    return undefined;
}

export function isTerminalSessionTurnMutationAction(action: SessionTurnMutationAction): boolean {
    return action === 'complete' || action === 'fail' || action === 'cancel' || action === 'end_session';
}
