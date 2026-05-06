import { describe, expect, it } from 'vitest';

import { deriveSessionAttentionState } from './deriveSessionAttentionState';

const runtimeIssue = {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'provider_status_error',
    source: 'provider_status_error',
    occurredAt: 100,
} as const;

describe('deriveSessionAttentionState', () => {
    it('prioritizes failed primary-session attention over waiting, running, and review signals', async () => {
        expect(deriveSessionAttentionState({
            latestTurnStatus: 'failed',
            lastRuntimeIssue: runtimeIssue,
            hasWaitingActivity: true,
            isRunning: true,
            hasReviewActivity: true,
        })).toBe('failed');
    });

    it('treats in-progress turns as running even when a previous runtime issue is present', async () => {
        expect(deriveSessionAttentionState({
            latestTurnStatus: 'in_progress',
            lastRuntimeIssue: runtimeIssue,
            hasWaitingActivity: true,
            isRunning: false,
            hasReviewActivity: true,
        })).toBe('running');
    });

    it('prioritizes waiting over running and review when the primary session is not failed', async () => {
        expect(deriveSessionAttentionState({
            latestTurnStatus: 'completed',
            lastRuntimeIssue: null,
            hasWaitingActivity: true,
            isRunning: true,
            hasReviewActivity: true,
        })).toBe('waiting');
    });

    it('does not treat execution-run or tool failures as failed session attention', async () => {
        expect(deriveSessionAttentionState({
            latestTurnStatus: 'completed',
            lastRuntimeIssue: null,
            hasWaitingActivity: false,
            isRunning: false,
            hasReviewActivity: true,
            hasExecutionRunFailure: true,
            hasToolFailure: true,
        })).toBe('review');
    });
});
