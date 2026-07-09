import { describe, expect, it } from 'vitest';

import type { TranscriptViewportLifecycleEffect } from './lifecycle';
import { resolveWebSettledReturnGenericEffects } from './webSettledReturnGenericEffect';

function firstGenericObservedStateEffect(
    effects: readonly TranscriptViewportLifecycleEffect[],
): Extract<TranscriptViewportLifecycleEffect, { type: 'apply-generic-observed-viewport-state' }> {
    const effect = effects[0];
    expect(effect?.type).toBe('apply-generic-observed-viewport-state');
    if (!effect || effect.type !== 'apply-generic-observed-viewport-state') {
        throw new Error('expected generic observed-state effect');
    }
    return effect;
}

const viewportEffect = {
    distanceFromLiveTailPx: 12,
    isPinned: true,
    sessionId: 'session-a',
    source: 'mode-following',
    type: 'viewport-change',
} as const satisfies TranscriptViewportLifecycleEffect;

const drainEffect = {
    distanceFromLiveTailPx: 12,
    isPinned: true,
    sessionId: 'session-a',
    type: 'drain-deferred-newer',
} as const satisfies TranscriptViewportLifecycleEffect;

describe('web settled return generic effects', () => {
    it('maps paired settled-return effects to generic observed-state effects', () => {
        expect(firstGenericObservedStateEffect(resolveWebSettledReturnGenericEffects({
            drainEffect,
            nextScrollOffsetPx: 512,
            pinEnabled: true,
            pinnedOffsetThresholdPx: 72,
            viewportEffect,
        }))).toEqual({
            sessionId: 'session-a',
            state: {
                anchorCapture: {
                    suppressAnchorCapture: false,
                    viewportState: {
                        isPinned: true,
                        offsetY: 12,
                        shouldRestoreViewport: false,
                    },
                },
                drain: {
                    distanceFromLiveTailPx: 12,
                    isPinned: true,
                },
                jumpButtonDistanceFromLiveTailPx: 12,
                lastDistanceFromLiveTailPx: 12,
                nextScrollOffsetPx: 512,
                scrollPinEvent: {
                    enabled: true,
                    offsetY: 12,
                    pinnedOffsetThresholdPx: 72,
                    type: 'scroll',
                },
                viewportState: {
                    isPinned: true,
                    offsetY: 12,
                    shouldRestoreViewport: false,
                },
                wantsPinned: true,
            },
            type: 'apply-generic-observed-viewport-state',
        });
    });

    it('does not guess when settled-return effects are not a matching pinned pair', () => {
        const unpinnedViewportEffect = {
            ...viewportEffect,
            isPinned: false,
        };

        expect(resolveWebSettledReturnGenericEffects({
            drainEffect: null,
            nextScrollOffsetPx: 512,
            pinEnabled: true,
            pinnedOffsetThresholdPx: 72,
            viewportEffect,
        })).toEqual([]);
        expect(resolveWebSettledReturnGenericEffects({
            drainEffect: {
                ...drainEffect,
                sessionId: 'session-b',
            },
            nextScrollOffsetPx: 512,
            pinEnabled: true,
            pinnedOffsetThresholdPx: 72,
            viewportEffect,
        })).toEqual([]);
        expect(resolveWebSettledReturnGenericEffects({
            drainEffect: {
                ...drainEffect,
                distanceFromLiveTailPx: 13,
            },
            nextScrollOffsetPx: 512,
            pinEnabled: true,
            pinnedOffsetThresholdPx: 72,
            viewportEffect,
        })).toEqual([]);
        expect(resolveWebSettledReturnGenericEffects({
            drainEffect,
            nextScrollOffsetPx: 512,
            pinEnabled: true,
            pinnedOffsetThresholdPx: 72,
            viewportEffect: unpinnedViewportEffect,
        })).toEqual([]);
    });

    it('uses the lifecycle-provided return distance without adding mapper normalization', () => {
        const effect = firstGenericObservedStateEffect(resolveWebSettledReturnGenericEffects({
            drainEffect: {
                ...drainEffect,
                distanceFromLiveTailPx: 0.5,
            },
            nextScrollOffsetPx: 24,
            pinEnabled: false,
            pinnedOffsetThresholdPx: 72,
            viewportEffect: {
                ...viewportEffect,
                distanceFromLiveTailPx: 0.5,
            },
        }));

        expect(effect.state.viewportState).toEqual({
            isPinned: true,
            offsetY: 0.5,
            shouldRestoreViewport: false,
        });
        expect(effect.state.lastDistanceFromLiveTailPx).toBe(0.5);
        expect(effect.state.scrollPinEvent).toMatchObject({
            enabled: false,
            offsetY: 0.5,
            pinnedOffsetThresholdPx: 72,
        });
    });
});
