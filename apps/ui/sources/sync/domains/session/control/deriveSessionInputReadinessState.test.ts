import { describe, expect, it } from 'vitest';

import { deriveSessionInputReadinessState } from './deriveSessionInputReadinessState';

describe('deriveSessionInputReadinessState', () => {
    const nowMs = 1_000_000;

    it('does not treat display-only provider runtime activity as input-busy', () => {
        const input = {
            active: true,
            activeAt: nowMs - 10_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed' as const,
            latestTurnStatusObservedAt: nowMs - 5_000,
            runtimeActivityState: 'active' as const,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 1_000,
            runtimeActivityRevision: nowMs + 60_000,
        };
        const readiness = deriveSessionInputReadinessState(input, nowMs);

        expect(readiness.disposition).toBe('accepts_next_turn');
        expect(readiness.isInputBusy).toBe(false);
        expect(readiness.canWakePendingQueue).toBe(true);
    });

    it('treats a fresh foreground in-progress turn as input-busy', () => {
        const readiness = deriveSessionInputReadinessState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - 1_000,
        }, nowMs);

        expect(readiness.disposition).toBe('blocked');
        expect(readiness.isInputBusy).toBe(true);
        expect(readiness.canWakePendingQueue).toBe(false);
    });

    it('keeps a projected in-progress turn input-busy until a terminal projection arrives', () => {
        const readiness = deriveSessionInputReadinessState({
            active: true,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - 300_000,
        }, nowMs);

        expect(readiness.disposition).toBe('blocked');
        expect(readiness.isInputBusy).toBe(true);
        expect(readiness.canWakePendingQueue).toBe(false);
    });

    it('treats a fresh optimistic pending user message as input-busy', () => {
        const readiness = deriveSessionInputReadinessState({
            active: true,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            optimisticThinkingAt: nowMs - 100,
            hasPendingUserMessages: true,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
        }, nowMs);

        expect(readiness.disposition).toBe('blocked');
        expect(readiness.isInputBusy).toBe(true);
        expect(readiness.canWakePendingQueue).toBe(false);
    });
});
