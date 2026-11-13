import { describe, expect, it } from 'vitest';

import { deriveSessionInputReadinessState } from './deriveSessionInputReadinessState';

describe('deriveSessionInputReadinessState', () => {
    const nowMs = 1_000_000;

    it('reads a running Session whose live presence is not yet observed (fresh client) by its running state', () => {
        // A fresh client has `active` from the snapshot and no presence sample until the runtime
        // next publishes. Unobserved presence is not a detach; an observed detach still is.
        const running = { active: true, activeAt: nowMs - 1_000, presence: undefined } as const;
        const dispositions = [
            deriveSessionInputReadinessState({ ...running, thinking: true, thinkingAt: nowMs - 1_000,
                inFlightSteerSupported: true, inFlightSteerAvailable: true }, nowMs).disposition,
            deriveSessionInputReadinessState({ ...running, latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: nowMs - 1_000 }, nowMs).disposition,
            deriveSessionInputReadinessState({ ...running, thinking: false, latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: nowMs - 1_000 }, nowMs).disposition,
        ];
        expect(dispositions).toEqual(['steer_available', 'blocked', 'accepts_next_turn']);
        expect(deriveSessionInputReadinessState({ ...running, presence: nowMs - 500 }, nowMs).disposition).toBe('offline');
        expect(deriveSessionInputReadinessState({ ...running, active: false }, nowMs).disposition).toBe('offline');
    });

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

    it('does not erase an observed pending permission merely because its timestamp is unavailable', () => {
        const readiness = deriveSessionInputReadinessState({
            active: true,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 1_000,
            hasPendingPermissionRequests: true,
            pendingRequestObservedAt: null,
        }, nowMs);

        expect(readiness.disposition).toBe('blocked');
        expect(readiness.isInputBusy).toBe(true);
        expect(readiness.canWakePendingQueue).toBe(false);
    });
});
