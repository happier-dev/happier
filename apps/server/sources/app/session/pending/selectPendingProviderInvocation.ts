import {
    normalizePendingRequestedActionV1,
    type PendingRequestedActionV1,
} from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import type { PendingProviderAction } from '@happier-dev/protocol/sessions/pending/pendingProviderAction';

export type PendingClaimForegroundState = 'ready' | 'active_steerable' | 'active_unsteerable';
export type PendingClaimDeliveryTiming = 'after_foreground_ready' | 'after_runtime_idle';
export type { PendingProviderAction } from '@happier-dev/protocol/sessions/pending/pendingProviderAction';

/** A definitive pre-claim Run refusal stays visible without fencing fresh input after recovery. */
export function isUnclaimedUnavailableExecutionRunInput(targetExecutionRunId: string | null, row: Readonly<{
    deliveryState: string | null;
    deliveryBlockedReason: string | null;
    providerAction: string | null;
}>): boolean {
    return targetExecutionRunId !== null
        && row.deliveryState === 'blocked'
        && row.deliveryBlockedReason === 'session_input_target_unavailable'
        && row.providerAction === null;
}

type PendingInvocationCandidate = Readonly<{
    localId: string;
    position: number;
    requestedAction: PendingRequestedActionV1 | unknown;
    deliveryState?: string | null;
    deliveryBlockedReason?: string | null;
}>;

export type PendingProviderInvocationSelection =
    | Readonly<{ localId: string; providerAction: PendingProviderAction }>
    | Readonly<{
        deferredReason:
            | 'no_pending'
            | 'waiting_for_foreground_turn'
            | 'waiting_for_runtime_activity'
            | 'runtime_activity_unknown'
            | 'waiting_for_quota_reset'
            | 'waiting_for_predecessor';
      }>;

function compareRows(left: PendingInvocationCandidate, right: PendingInvocationCandidate): number {
    return left.position - right.position || left.localId.localeCompare(right.localId);
}

function selectExactAction(
    row: PendingInvocationCandidate,
    foregroundState: PendingClaimForegroundState,
): PendingProviderInvocationSelection | null {
    if (row.deliveryState !== null && row.deliveryState !== undefined) return null;
    let action: PendingRequestedActionV1;
    try {
        action = normalizePendingRequestedActionV1(row.requestedAction, 'stored');
    } catch {
        return null;
    }
    if (action.kind === 'recover_execution_run') {
        return foregroundState === 'ready' ? { localId: row.localId, providerAction: 'send' } : null;
    }
    if (action.kind === 'send_now') {
        return {
            localId: row.localId,
            providerAction: foregroundState === 'ready' ? 'send' : 'interrupt_and_send',
        };
    }
    if (action.kind === 'steer_now') {
        return {
            localId: row.localId,
            providerAction: foregroundState === 'ready' ? 'send' : 'steer',
        };
    }
    if (action.kind === 'steer_if_active' && foregroundState === 'active_steerable') {
        return { localId: row.localId, providerAction: 'steer' };
    }
    return null;
}

export function selectPendingProviderInvocation(params: Readonly<{
    rows: readonly PendingInvocationCandidate[];
    foregroundState: PendingClaimForegroundState;
    deliveryTiming: PendingClaimDeliveryTiming;
    readRuntimeActivity: () => 'idle' | 'active' | 'unknown';
}>): PendingProviderInvocationSelection {
    // The final Team refusal remains visible for the original input but cannot
    // fence independent fresh input after regrant. Never re-dispatch that row.
    const ordered = params.rows.filter(row => row.deliveryState !== 'blocked'
        || row.deliveryBlockedReason !== 'team_access_removed').sort(compareRows);
    if (ordered.length === 0) return { deferredReason: 'no_pending' };
    if (ordered[0]!.deliveryState === 'delivering') {
        return { deferredReason: 'waiting_for_predecessor' };
    }

    // Automatic claims remain FIFO. An explicit action instead targets its exact localId and may
    // bypass ordinary or blocked predecessors; any unresolved delivering claim is rejoined before
    // this selector and remains a hard predecessor above.
    for (const row of ordered) {
        const exactAction = selectExactAction(row, params.foregroundState);
        if (exactAction) return exactAction;
    }

    const candidate = ordered[0]!;
    if (candidate.deliveryState !== null && candidate.deliveryState !== undefined) {
        return { deferredReason: 'waiting_for_predecessor' };
    }
    const action = normalizePendingRequestedActionV1(candidate.requestedAction, 'stored');
    if (action.kind === 'reset_start') return { deferredReason: 'waiting_for_quota_reset' };

    if (params.foregroundState !== 'ready') {
        return { deferredReason: 'waiting_for_foreground_turn' };
    }
    const runtimeActivity = params.deliveryTiming === 'after_runtime_idle'
        ? params.readRuntimeActivity()
        : 'idle';
    if (runtimeActivity !== 'idle') {
        return {
            deferredReason: runtimeActivity === 'active'
                ? 'waiting_for_runtime_activity'
                : 'runtime_activity_unknown',
        };
    }
    return { localId: candidate.localId, providerAction: 'send' };
}
