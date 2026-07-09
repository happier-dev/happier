import { describe, expect, it } from 'vitest';

import type { TranscriptViewportLifecycleEffect } from './lifecycle';
import { resolveExplicitReturnToLiveTailViewportEffects } from './explicitReturnToLiveTail';

const explicitReturnViewportEffect = (
    overrides: Partial<Extract<TranscriptViewportLifecycleEffect, { type: 'viewport-change' }>> = {},
): Extract<TranscriptViewportLifecycleEffect, { type: 'viewport-change' }> => ({
    distanceFromLiveTailPx: 0,
    isPinned: true,
    sessionId: 'session-a',
    source: 'explicit-return',
    type: 'viewport-change',
    ...overrides,
});

describe('explicit return-to-live-tail viewport effects', () => {
    it('returns no apply effects when none match the current session', () => {
        expect(resolveExplicitReturnToLiveTailViewportEffects({
            effects: [],
            sessionId: 'session-a',
        })).toEqual([]);

        expect(resolveExplicitReturnToLiveTailViewportEffects({
            effects: [
                explicitReturnViewportEffect({ sessionId: 'session-b' }),
                {
                    distanceFromLiveTailPx: 0,
                    isPinned: true,
                    sessionId: 'session-a',
                    source: 'mode-following',
                    type: 'viewport-change',
                },
            ],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('maps current-session explicit-return viewport changes to typed apply effects', () => {
        expect(resolveExplicitReturnToLiveTailViewportEffects({
            effects: [explicitReturnViewportEffect({ distanceFromLiveTailPx: 7 })],
            sessionId: 'session-a',
        })).toEqual([
            {
                distanceFromLiveTailPx: 7,
                isPinned: true,
                sessionId: 'session-a',
                type: 'apply-explicit-return-to-live-tail-viewport',
            },
        ]);
    });

    it('ignores unrelated lifecycle effects and non-explicit viewport changes', () => {
        expect(resolveExplicitReturnToLiveTailViewportEffects({
            effects: [
                {
                    distanceFromLiveTailPx: 4,
                    isPinned: true,
                    sessionId: 'session-a',
                    source: 'mode-following',
                    type: 'viewport-change',
                },
                {
                    distanceFromLiveTailPx: 0,
                    isPinned: true,
                    sessionId: 'session-a',
                    type: 'drain-deferred-newer',
                },
                {
                    reason: 'jump-to-bottom',
                    sessionId: 'session-a',
                    type: 'explicit-jump-preempt-entry-restore',
                },
                {
                    sessionId: 'session-a',
                    type: 'follow-bottom-intent-preempt-entry-restore',
                },
                {
                    distanceFromLiveTailPx: 0,
                    isPinned: true,
                    sessionId: 'session-a',
                    shouldRestoreViewport: false,
                    type: 'session-entry-viewport',
                },
            ],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('preserves matching explicit-return viewport order and multiplicity', () => {
        expect(resolveExplicitReturnToLiveTailViewportEffects({
            effects: [
                explicitReturnViewportEffect({ distanceFromLiveTailPx: 2 }),
                explicitReturnViewportEffect({ distanceFromLiveTailPx: 1, sessionId: 'session-b' }),
                explicitReturnViewportEffect({ distanceFromLiveTailPx: 0 }),
            ],
            sessionId: 'session-a',
        })).toEqual([
            {
                distanceFromLiveTailPx: 2,
                isPinned: true,
                sessionId: 'session-a',
                type: 'apply-explicit-return-to-live-tail-viewport',
            },
            {
                distanceFromLiveTailPx: 0,
                isPinned: true,
                sessionId: 'session-a',
                type: 'apply-explicit-return-to-live-tail-viewport',
            },
        ]);
    });
});
