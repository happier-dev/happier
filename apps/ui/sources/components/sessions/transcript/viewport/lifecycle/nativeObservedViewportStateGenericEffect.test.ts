import { describe, expect, it } from 'vitest';

import type { TranscriptViewportLifecycleEffect } from './lifecycle';
import {
    resolveNativeObservedViewportStateGenericEffects,
    resolveNativeObservedViewportStateGenericLifecycleEffects,
} from './nativeObservedViewportStateGenericEffect';

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

const followingObservedEffect = (overrides: Partial<Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'native-observed-viewport-state' }
>> = {}): Extract<TranscriptViewportLifecycleEffect, { type: 'native-observed-viewport-state' }> => ({
    distanceFromLiveTailPx: 96,
    isPinned: false,
    pinnedOffsetThresholdPx: 72,
    sessionId: 'session-a',
    shouldRestoreViewport: false,
    type: 'native-observed-viewport-state',
    wantsPinned: true,
    ...overrides,
});

describe('native observed viewport-state generic effects', () => {
    it('maps following native observed state to generic observed-state effects', () => {
        expect(firstGenericObservedStateEffect(resolveNativeObservedViewportStateGenericEffects({
            effect: followingObservedEffect(),
            nextScrollOffsetPx: 512.9,
            pinEnabled: true,
            suppressAnchorCapture: true,
        }))).toEqual({
            sessionId: 'session-a',
            state: {
                anchorCapture: {
                    suppressAnchorCapture: true,
                    viewportState: {
                        isPinned: false,
                        offsetY: 96,
                        shouldPersistViewport: false,
                        shouldRestoreViewport: false,
                    },
                },
                drain: {
                    distanceFromLiveTailPx: 96,
                    isPinned: false,
                },
                jumpButtonDistanceFromLiveTailPx: 96,
                lastDistanceFromLiveTailPx: 96,
                nextScrollOffsetPx: 512,
                scrollPinEvent: {
                    enabled: true,
                    offsetY: 96,
                    pinnedOffsetThresholdPx: 72,
                    type: 'scroll',
                },
                viewportState: {
                    isPinned: false,
                    offsetY: 96,
                    shouldPersistViewport: false,
                    shouldRestoreViewport: false,
                },
                wantsPinned: true,
            },
            type: 'apply-generic-observed-viewport-state',
        });
    });

    it('preserves released native observed state', () => {
        const effect = firstGenericObservedStateEffect(resolveNativeObservedViewportStateGenericEffects({
            effect: {
                ...followingObservedEffect(),
                distanceFromLiveTailPx: 180,
                pinnedOffsetThresholdPx: 0,
                shouldRestoreViewport: true,
                wantsPinned: false,
            },
            nextScrollOffsetPx: 24,
            pinEnabled: false,
            suppressAnchorCapture: false,
        }));

        expect(effect.state.viewportState).toEqual({
            isPinned: false,
            offsetY: 180,
            shouldPersistViewport: false,
            shouldRestoreViewport: true,
        });
        expect(effect.state.drain).toEqual({
            distanceFromLiveTailPx: 180,
            isPinned: false,
        });
        expect(effect.state.scrollPinEvent).toMatchObject({
            enabled: false,
            offsetY: 180,
            pinnedOffsetThresholdPx: 0,
        });
        expect(effect.state.wantsPinned).toBe(false);
    });

    it('preserves pinned native observed state without forced anchor suppression', () => {
        const effect = firstGenericObservedStateEffect(resolveNativeObservedViewportStateGenericEffects({
            effect: {
                ...followingObservedEffect(),
                distanceFromLiveTailPx: 0,
                isPinned: true,
            },
            nextScrollOffsetPx: 0,
            pinEnabled: true,
            suppressAnchorCapture: false,
        }));

        expect(effect.state.viewportState).toEqual({
            isPinned: true,
            offsetY: 0,
            shouldPersistViewport: false,
            shouldRestoreViewport: false,
        });
        expect(effect.state.drain).toEqual({
            distanceFromLiveTailPx: 0,
            isPinned: true,
        });
        expect(effect.state.jumpButtonDistanceFromLiveTailPx).toBe(0);
        expect(effect.state.anchorCapture.suppressAnchorCapture).toBe(false);
    });

    it('clamps invalid next scroll offsets to the existing host-safe zero', () => {
        for (const nextScrollOffsetPx of [-12, Number.NaN, Number.POSITIVE_INFINITY]) {
            const effect = firstGenericObservedStateEffect(resolveNativeObservedViewportStateGenericEffects({
                effect: followingObservedEffect(),
                nextScrollOffsetPx,
                pinEnabled: false,
                suppressAnchorCapture: false,
            }));

            expect(effect.state.nextScrollOffsetPx).toBe(0);
        }
    });

    it('returns no generic effects when no native observed state exists for the current session', () => {
        expect(resolveNativeObservedViewportStateGenericLifecycleEffects({
            effects: [],
            nextScrollOffsetPx: 8,
            pinEnabled: true,
            sessionId: 'session-a',
            suppressAnchorCapture: false,
        })).toEqual([]);

        expect(resolveNativeObservedViewportStateGenericLifecycleEffects({
            effects: [followingObservedEffect({ sessionId: 'session-b' })],
            nextScrollOffsetPx: 8,
            pinEnabled: true,
            sessionId: 'session-a',
            suppressAnchorCapture: false,
        })).toEqual([]);
    });

    it('projects the current-session native observed state through the existing generic mapping', () => {
        const effects = resolveNativeObservedViewportStateGenericLifecycleEffects({
            effects: [followingObservedEffect()],
            nextScrollOffsetPx: 44.9,
            pinEnabled: true,
            sessionId: 'session-a',
            suppressAnchorCapture: true,
        });

        expect(firstGenericObservedStateEffect(effects)).toMatchObject({
            sessionId: 'session-a',
            state: {
                anchorCapture: {
                    suppressAnchorCapture: true,
                },
                lastDistanceFromLiveTailPx: 96,
                nextScrollOffsetPx: 44,
                wantsPinned: true,
            },
            type: 'apply-generic-observed-viewport-state',
        });
    });

    it('filters mixed effects down to the current-session native observed state', () => {
        const effects = resolveNativeObservedViewportStateGenericLifecycleEffects({
            effects: [
                followingObservedEffect({ sessionId: 'session-b' }),
                {
                    distanceFromLiveTailPx: 120,
                    isPinned: false,
                    sessionId: 'session-a',
                    type: 'native-scroll-release-live-tail',
                },
                followingObservedEffect({ distanceFromLiveTailPx: 132 }),
            ],
            nextScrollOffsetPx: 12,
            pinEnabled: false,
            sessionId: 'session-a',
            suppressAnchorCapture: false,
        });

        expect(firstGenericObservedStateEffect(effects).state.lastDistanceFromLiveTailPx).toBe(132);
    });

    it('preserves first-match behavior for multiple current-session native observed states', () => {
        const effects = resolveNativeObservedViewportStateGenericLifecycleEffects({
            effects: [
                followingObservedEffect({ distanceFromLiveTailPx: 120 }),
                followingObservedEffect({ distanceFromLiveTailPx: 180 }),
            ],
            nextScrollOffsetPx: -10,
            pinEnabled: false,
            sessionId: 'session-a',
            suppressAnchorCapture: true,
        });

        const effect = firstGenericObservedStateEffect(effects);
        expect(effect.state.lastDistanceFromLiveTailPx).toBe(120);
        expect(effect.state.nextScrollOffsetPx).toBe(0);
        expect(effect.state.anchorCapture.suppressAnchorCapture).toBe(true);
    });
});
