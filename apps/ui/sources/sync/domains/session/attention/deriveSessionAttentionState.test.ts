import { describe, expect, it } from 'vitest';

import { deriveSessionAttentionState } from './deriveSessionAttentionState';

const runtimeIssue = {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'agent_status_error',
    source: 'agent_status_error',
    occurredAt: 100,
} as const;

describe('deriveSessionAttentionState', () => {
    it('prioritizes failed primary-turn attention over waiting, running, and review signals', async () => {
        expect(deriveSessionAttentionState({
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: 1_000,
            lastRuntimeIssue: null,
            active: true,
            presence: 'online',
            pendingRequestObservedAt: 1_000,
            hasWaitingActivity: true,
            isRunning: true,
            hasReviewActivity: true,
            nowMs: 1_001,
        })).toBe('failed');
    });

    it('does not let stale waiting activity override review attention', async () => {
        expect(deriveSessionAttentionState({
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 1_000,
            lastRuntimeIssue: runtimeIssue,
            hasWaitingActivity: true,
            isRunning: false,
            hasReviewActivity: true,
            nowMs: 121_001,
        })).toBe('review');
    });

    it('treats fresh in-progress turns as running', async () => {
        expect(deriveSessionAttentionState({
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_000,
            lastRuntimeIssue: runtimeIssue,
            hasWaitingActivity: false,
            isRunning: false,
            hasReviewActivity: true,
            nowMs: 2_000,
        })).toBe('running');
    });

    it('keeps an in-progress turn running until an explicit terminal projection', async () => {
        expect(deriveSessionAttentionState({
            active: true,
            activeAt: 121_000,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_000,
            lastRuntimeIssue: runtimeIssue,
            hasWaitingActivity: false,
            isRunning: false,
            hasReviewActivity: true,
            nowMs: 122_000,
        })).toBe('running');
    });

    it('does not read provider activity while deriving session attention', async () => {
        const nowMs = 1_000_000;
        const input = {
            active: true,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed' as const,
            latestTurnStatusObservedAt: nowMs - 10_000,
            get runtimeActivityState(): never {
                throw new Error('session attention must not read provider activity');
            },
            get runtimeActivityActiveCount(): never {
                throw new Error('session attention must not read provider activity');
            },
            hasWaitingActivity: false,
            hasReviewActivity: true,
            nowMs,
        };

        expect(deriveSessionAttentionState(input)).toBe('review');
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

    it('clears running attention after a completed primary turn projection', async () => {
        expect(deriveSessionAttentionState({
            latestTurnStatus: 'completed',
            lastRuntimeIssue: null,
            isRunning: true,
        })).toBe('idle');
    });
});
