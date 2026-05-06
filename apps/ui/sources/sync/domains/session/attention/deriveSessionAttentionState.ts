import type {
    DeriveSessionAttentionStateInput,
    SessionAttentionState,
} from './types';

export function deriveSessionAttentionState(
    input: DeriveSessionAttentionStateInput,
): SessionAttentionState {
    if (input.latestTurnStatus === 'in_progress') return 'running';
    if (input.latestTurnStatus === 'failed' && input.lastRuntimeIssue != null) return 'failed';
    if (input.hasWaitingActivity === true) return 'waiting';
    if (input.isRunning === true) return 'running';
    if (input.hasReviewActivity === true) return 'review';
    return 'idle';
}
