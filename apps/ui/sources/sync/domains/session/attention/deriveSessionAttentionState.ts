import type {
    DeriveSessionAttentionStateInput,
    SessionAttentionState,
} from './types';
import { deriveSessionRuntimePresentationState } from './runtimePresentation';

export function deriveSessionAttentionState(
    input: DeriveSessionAttentionStateInput,
): SessionAttentionState {
    const runtimePresentation = deriveSessionRuntimePresentationState({
        active: input.active,
        activeAt: input.activeAt,
        presence: input.presence,
        thinking: input.thinking,
        thinkingAt: input.thinkingAt,
        latestTurnStatus: input.latestTurnStatus,
        latestTurnStatusObservedAt: input.latestTurnStatusObservedAt,
        meaningfulActivityAt: input.meaningfulActivityAt,
        lastRuntimeIssue: input.lastRuntimeIssue,
        hasPendingPermissionRequests: input.hasWaitingActivity,
        pendingRequestObservedAt: input.pendingRequestObservedAt,
        nowMs: input.nowMs,
    });

    const hasRuntimeFreshnessInput =
        input.active != null
        || input.presence != null
        || input.thinking != null
        || input.thinkingAt != null
        || input.latestTurnStatusObservedAt != null
        || input.pendingRequestObservedAt != null;
    const hasFreshWaitingActivity =
        runtimePresentation.freshPermissionRequired
        || runtimePresentation.freshActionRequired;
    const hasLegacyWaitingActivity =
        input.hasWaitingActivity === true
        && !hasRuntimeFreshnessInput;

    if (runtimePresentation.attention === 'failed') return 'failed';
    if (hasFreshWaitingActivity || input.hasQueuedUserInput === true || hasLegacyWaitingActivity) return 'waiting';
    if (runtimePresentation.working) return 'running';
    if (input.hasReviewActivity === true) return 'review';
    return 'idle';
}
