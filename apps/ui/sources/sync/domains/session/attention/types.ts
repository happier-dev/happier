import type {
    PrimaryTurnStatusV1,
    SessionRuntimeIssueV1,
} from '@happier-dev/protocol';

export type SessionAttentionState = 'idle' | 'running' | 'waiting' | 'failed' | 'review';

export type DeriveSessionAttentionStateInput = Readonly<{
    active?: boolean | null;
    activeAt?: number | null;
    presence?: unknown;
    thinking?: boolean | null;
    thinkingAt?: number | null;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt?: number | null;
    meaningfulActivityAt?: number | null;
    lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
    pendingRequestObservedAt?: number | null;
    hasWaitingActivity?: boolean;
    hasQueuedUserInput?: boolean;
    isRunning?: boolean;
    hasReviewActivity?: boolean;
    hasExecutionRunFailure?: boolean;
    hasToolFailure?: boolean;
    nowMs?: number;
}>;
