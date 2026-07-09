import { describe, expect, it } from 'vitest';

import type { TranscriptViewportLifecycleEffect } from './lifecycle';
import {
    resolveNativeScrollReleaseLiveTailGenericEffects,
    resolveNativeScrollReleaseLiveTailGenericLifecycleEffects,
} from './nativeScrollReleaseLiveTailGenericEffect';

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

const releaseEffect = (overrides: Partial<Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'native-scroll-release-live-tail' }
>> = {}): Extract<TranscriptViewportLifecycleEffect, { type: 'native-scroll-release-live-tail' }> => ({
    distanceFromLiveTailPx: 180,
    isPinned: false,
    sessionId: 'session-a',
    type: 'native-scroll-release-live-tail',
    ...overrides,
});

describe('native scroll release live-tail generic effects', () => {
    it('maps native release effects to generic observed-state effects', () => {
        expect(firstGenericObservedStateEffect(resolveNativeScrollReleaseLiveTailGenericEffects({
            effect: releaseEffect(),
            nextScrollOffsetPx: 512.9,
            pinEnabled: true,
        }))).toEqual({
            sessionId: 'session-a',
            state: {
                anchorCapture: {
                    suppressAnchorCapture: false,
                    viewportState: {
                        isPinned: false,
                        offsetY: 180,
                        shouldRestoreViewport: true,
                    },
                },
                drain: {
                    distanceFromLiveTailPx: 180,
                    isPinned: false,
                },
                jumpButtonDistanceFromLiveTailPx: 180,
                lastDistanceFromLiveTailPx: 180,
                nextScrollOffsetPx: 512,
                scrollPinEvent: {
                    enabled: true,
                    offsetY: 180,
                    pinnedOffsetThresholdPx: 0,
                    type: 'scroll',
                },
                viewportState: {
                    isPinned: false,
                    offsetY: 180,
                    shouldRestoreViewport: true,
                },
                wantsPinned: false,
            },
            type: 'apply-generic-observed-viewport-state',
        });
    });

    it('clamps invalid next scroll offsets to the existing host-safe zero', () => {
        for (const nextScrollOffsetPx of [-12, Number.NaN, Number.POSITIVE_INFINITY]) {
            const effect = firstGenericObservedStateEffect(resolveNativeScrollReleaseLiveTailGenericEffects({
                effect: releaseEffect(),
                nextScrollOffsetPx,
                pinEnabled: false,
            }));

            expect(effect.state.nextScrollOffsetPx).toBe(0);
        }
    });

    it('uses the lifecycle-provided release distance without adding mapper normalization', () => {
        const effect = firstGenericObservedStateEffect(resolveNativeScrollReleaseLiveTailGenericEffects({
            effect: {
                ...releaseEffect(),
                distanceFromLiveTailPx: 0.5,
            },
            nextScrollOffsetPx: 24,
            pinEnabled: false,
        }));

        expect(effect.state.viewportState).toEqual({
            isPinned: false,
            offsetY: 0.5,
            shouldRestoreViewport: true,
        });
        expect(effect.state.lastDistanceFromLiveTailPx).toBe(0.5);
        expect(effect.state.scrollPinEvent).toMatchObject({
            enabled: false,
            offsetY: 0.5,
            pinnedOffsetThresholdPx: 0,
        });
    });

    it('returns no generic effects when no native scroll release effect exists for the current session', () => {
        expect(resolveNativeScrollReleaseLiveTailGenericLifecycleEffects({
            effects: [],
            nextScrollOffsetPx: 8,
            pinEnabled: true,
            sessionId: 'session-a',
        })).toEqual([]);

        expect(resolveNativeScrollReleaseLiveTailGenericLifecycleEffects({
            effects: [releaseEffect({ sessionId: 'session-b' })],
            nextScrollOffsetPx: 8,
            pinEnabled: true,
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('projects the current-session native scroll release through the existing generic mapping', () => {
        const effects = resolveNativeScrollReleaseLiveTailGenericLifecycleEffects({
            effects: [releaseEffect()],
            nextScrollOffsetPx: 44.9,
            pinEnabled: true,
            sessionId: 'session-a',
        });

        expect(firstGenericObservedStateEffect(effects)).toMatchObject({
            sessionId: 'session-a',
            state: {
                lastDistanceFromLiveTailPx: 180,
                nextScrollOffsetPx: 44,
                wantsPinned: false,
            },
            type: 'apply-generic-observed-viewport-state',
        });
    });

    it('filters mixed effects down to the current-session native scroll release', () => {
        const effects = resolveNativeScrollReleaseLiveTailGenericLifecycleEffects({
            effects: [
                releaseEffect({ sessionId: 'session-b' }),
                {
                    distanceFromLiveTailPx: 22,
                    isPinned: true,
                    pinnedOffsetThresholdPx: 72,
                    sessionId: 'session-a',
                    shouldRestoreViewport: true,
                    type: 'native-observed-viewport-state',
                    wantsPinned: true,
                },
                releaseEffect({ distanceFromLiveTailPx: 96 }),
            ],
            nextScrollOffsetPx: 12,
            pinEnabled: false,
            sessionId: 'session-a',
        });

        expect(firstGenericObservedStateEffect(effects).state.lastDistanceFromLiveTailPx).toBe(96);
    });

    it('preserves first-match behavior for multiple current-session native scroll release effects', () => {
        const effects = resolveNativeScrollReleaseLiveTailGenericLifecycleEffects({
            effects: [
                releaseEffect({ distanceFromLiveTailPx: 120 }),
                releaseEffect({ distanceFromLiveTailPx: 180 }),
            ],
            nextScrollOffsetPx: -10,
            pinEnabled: false,
            sessionId: 'session-a',
        });

        const effect = firstGenericObservedStateEffect(effects);
        expect(effect.state.lastDistanceFromLiveTailPx).toBe(120);
        expect(effect.state.nextScrollOffsetPx).toBe(0);
    });
});
