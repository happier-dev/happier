import type { PrimaryTurnStatusV1 } from '@happier-dev/protocol';

import {
    hasProjectedActiveTurn,
    hasTerminalPrimaryTurnStatus,
    isFreshTimestamp,
    normalizeRuntimeStatusTimestamp,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
    SESSION_OPTIMISTIC_PENDING_THINKING_MS,
} from '@/sync/domains/session/attention/runtimePresentation';

export type SessionInputReadinessDisposition =
    | 'accepts_next_turn'
    | 'steer_available'
    | 'blocked'
    | 'offline';

export type SessionInputReadinessState = Readonly<{
    disposition: SessionInputReadinessDisposition;
    isInputBusy: boolean;
    canWakePendingQueue: boolean;
}>;

export type DeriveSessionInputReadinessStateInput = Readonly<{
    active?: boolean | null;
    activeAt?: number | null;
    presence?: unknown;
    thinking?: boolean | null;
    thinkingAt?: number | null;
    optimisticThinkingAt?: number | null;
    hasPendingUserMessages?: boolean | null;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt?: number | null;
    hasPendingPermissionRequests?: boolean | null;
    hasPendingUserActionRequests?: boolean | null;
    pendingRequestObservedAt?: number | null;
    inFlightSteerSupported?: boolean | null;
    inFlightSteerAvailable?: boolean | null;
}>;

export function deriveSessionInputReadinessState(
    input: DeriveSessionInputReadinessStateInput,
    nowMs: number,
): SessionInputReadinessState {
    const isOnline = input.active === true && input.presence === 'online';
    if (!isOnline) {
        return {
            disposition: 'offline',
            isInputBusy: false,
            canWakePendingQueue: false,
        };
    }

    const foregroundBusy = hasFreshForegroundRuntimeActivity(input, nowMs);
    const optimisticPendingBusy = hasFreshOptimisticPendingUserMessage(input, nowMs);
    const hasFreshPendingRequest = isFreshTimestamp(
        normalizeRuntimeStatusTimestamp(input.pendingRequestObservedAt),
        nowMs,
        SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
    );
    const hasRequestGate =
        (input.hasPendingPermissionRequests === true || input.hasPendingUserActionRequests === true)
        && (foregroundBusy || optimisticPendingBusy || hasFreshPendingRequest);

    if (hasRequestGate) {
        return {
            disposition: 'blocked',
            isInputBusy: true,
            canWakePendingQueue: false,
        };
    }

    if (foregroundBusy || optimisticPendingBusy) {
        return {
            disposition:
                foregroundBusy
                && input.inFlightSteerSupported === true
                && input.inFlightSteerAvailable === true
                    ? 'steer_available'
                    : 'blocked',
            isInputBusy: true,
            canWakePendingQueue: false,
        };
    }

    return {
        disposition: 'accepts_next_turn',
        isInputBusy: false,
        canWakePendingQueue: true,
    };
}

function hasFreshOptimisticPendingUserMessage(
    input: DeriveSessionInputReadinessStateInput,
    nowMs: number,
): boolean {
    const latestTurnStatus = input.latestTurnStatus ?? null;
    if (hasTerminalPrimaryTurnStatus(latestTurnStatus)) return false;
    return input.hasPendingUserMessages === true
        && input.active === true
        && input.presence === 'online'
        && isFreshTimestamp(
            normalizeRuntimeStatusTimestamp(input.optimisticThinkingAt),
            nowMs,
            SESSION_OPTIMISTIC_PENDING_THINKING_MS,
        );
}

function hasFreshForegroundRuntimeActivity(
    input: DeriveSessionInputReadinessStateInput,
    nowMs: number,
): boolean {
    const latestTurnStatus = input.latestTurnStatus ?? null;
    if (hasProjectedActiveTurn(latestTurnStatus)) return true;
    if (hasTerminalPrimaryTurnStatus(latestTurnStatus)) return false;
    return input.thinking === true
        && input.active === true
        && input.presence === 'online'
        && isFreshTimestamp(
            normalizeRuntimeStatusTimestamp(input.thinkingAt),
            nowMs,
            SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
        );
}
