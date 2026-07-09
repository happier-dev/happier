import { describe, expect, it } from 'vitest';

import {
    resolveActiveWebScrollFallbackObservationEffects,
    resolveWebScrollFallbackFollowIntent,
    resolveWebScrollFallbackObservationEffects,
} from './webScrollFallbackFollowIntent';
import type { TranscriptViewportLifecycleEffect } from './lifecycle';

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

describe('web scroll fallback follow intent', () => {
    const baseParams = {
        distanceFromLiveTailPx: 96,
        pinThresholdPx: 72,
        previousScrollOffset: 120,
        recentUserIntent: true,
        scrollOffset: 80,
        wantsPinned: true,
    };
    const sessionId = 'session-a';

    it('releases on recent user intent plus movement away from the live tail', () => {
        expect(resolveWebScrollFallbackFollowIntent(baseParams)).toMatchObject({
            released: true,
            wantsPinned: false,
        });
    });

    it('does not release without recent user intent', () => {
        expect(resolveWebScrollFallbackFollowIntent({
            ...baseParams,
            recentUserIntent: false,
        })).toMatchObject({
            released: false,
            wantsPinned: true,
        });
    });

    it('rearms at or near the live tail using max-offset direction', () => {
        expect(resolveWebScrollFallbackFollowIntent({
            ...baseParams,
            distanceFromLiveTailPx: 24,
            previousScrollOffset: 80,
            scrollOffset: 120,
            wantsPinned: false,
        })).toMatchObject({
            isPinned: true,
            rearmed: true,
            wantsPinned: true,
        });
    });

    it('packages released no-live-metrics fallback viewport-state effects', () => {
        expect(resolveWebScrollFallbackObservationEffects({
            ...baseParams,
            pinEnabled: true,
            sessionId,
        })).toEqual([
            {
                sessionId,
                state: {
                    anchorCapture: {
                        suppressAnchorCapture: false,
                        viewportState: {
                            isPinned: false,
                            offsetY: 96,
                            shouldRestoreViewport: true,
                        },
                    },
                    drain: {
                        distanceFromLiveTailPx: 96,
                        isPinned: false,
                    },
                    jumpButtonDistanceFromLiveTailPx: 96,
                    lastDistanceFromLiveTailPx: 96,
                    nextScrollOffsetPx: 80,
                    scrollPinEvent: {
                        enabled: true,
                        offsetY: 96,
                        pinnedOffsetThresholdPx: 0,
                        type: 'scroll',
                    },
                    viewportState: {
                        isPinned: false,
                        offsetY: 96,
                        shouldRestoreViewport: true,
                    },
                    wantsPinned: false,
                },
                type: 'apply-generic-observed-viewport-state',
            },
        ]);
    });

    it('packages steady no-live-metrics fallback viewport-state effects without release authority', () => {
        expect(firstGenericObservedStateEffect(resolveWebScrollFallbackObservationEffects({
            ...baseParams,
            pinEnabled: false,
            recentUserIntent: false,
            sessionId,
        })).state).toMatchObject({
            anchorCapture: {
                suppressAnchorCapture: false,
            },
            scrollPinEvent: {
                enabled: false,
                pinnedOffsetThresholdPx: 72,
            },
            viewportState: {
                isPinned: false,
                shouldRestoreViewport: false,
            },
            wantsPinned: true,
        });
    });

    it('packages rearmed no-live-metrics fallback viewport-state effects near the live tail', () => {
        expect(firstGenericObservedStateEffect(resolveWebScrollFallbackObservationEffects({
            ...baseParams,
            distanceFromLiveTailPx: 24,
            pinEnabled: true,
            previousScrollOffset: 80,
            scrollOffset: 120,
            sessionId,
            wantsPinned: false,
        })).state).toMatchObject({
            anchorCapture: {
                suppressAnchorCapture: false,
            },
            drain: {
                distanceFromLiveTailPx: 24,
                isPinned: true,
            },
            scrollPinEvent: {
                enabled: true,
                pinnedOffsetThresholdPx: 72,
            },
            viewportState: {
                isPinned: true,
                offsetY: 24,
                shouldRestoreViewport: false,
            },
            wantsPinned: true,
        });
    });

    it('does not package active fallback effects outside web', () => {
        expect(resolveActiveWebScrollFallbackObservationEffects({
            ...baseParams,
            hasLiveWebMetrics: false,
            isWeb: false,
            pinEnabled: true,
            sessionId,
        })).toEqual([]);
    });

    it('does not package active fallback effects when live web metrics are available', () => {
        expect(resolveActiveWebScrollFallbackObservationEffects({
            ...baseParams,
            hasLiveWebMetrics: true,
            isWeb: true,
            pinEnabled: true,
            sessionId,
        })).toEqual([]);
    });

    it('packages active fallback effects only for web without live metrics', () => {
        const effects = resolveActiveWebScrollFallbackObservationEffects({
            ...baseParams,
            hasLiveWebMetrics: false,
            isWeb: true,
            pinEnabled: true,
            sessionId,
        });

        expect(effects[0]).toEqual({
            ...resolveWebScrollFallbackObservationEffects({
                ...baseParams,
                pinEnabled: true,
                sessionId,
            })[0],
            state: expect.objectContaining({
                anchorCapture: expect.objectContaining({
                    suppressAnchorCapture: true,
                }),
            }),
        });
        expect(effects).toHaveLength(2);
        expect(effects[1]).toEqual({
            reason: 'web-no-live-metrics-fallback-release',
            sessionId,
            type: 'cancel-scheduled-viewport-anchor-capture',
        });
    });

    it('suppresses active fallback anchor capture only when no-live-metrics fallback releases follow mode', () => {
        expect(firstGenericObservedStateEffect(resolveActiveWebScrollFallbackObservationEffects({
            ...baseParams,
            hasLiveWebMetrics: false,
            isWeb: true,
            pinEnabled: true,
            sessionId,
        })).state.anchorCapture.suppressAnchorCapture).toBe(true);

        expect(firstGenericObservedStateEffect(resolveActiveWebScrollFallbackObservationEffects({
            ...baseParams,
            hasLiveWebMetrics: false,
            isWeb: true,
            pinEnabled: true,
            recentUserIntent: false,
            sessionId,
        })).state.anchorCapture.suppressAnchorCapture).toBe(false);
    });
});
