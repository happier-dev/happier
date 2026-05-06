import type {
    PrimaryTurnStatusV1,
    SessionRuntimeIssueV1,
} from '@happier-dev/protocol';

export type SessionAttentionState = 'idle' | 'running' | 'waiting' | 'failed' | 'review';

export type DeriveSessionAttentionStateInput = Readonly<{
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
    hasWaitingActivity?: boolean;
    isRunning?: boolean;
    hasReviewActivity?: boolean;
    hasExecutionRunFailure?: boolean;
    hasToolFailure?: boolean;
}>;
