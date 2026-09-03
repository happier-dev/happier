import { describe, expect, it } from 'vitest';

import type { TranscriptViewportLifecycleEffect } from './lifecycle';
import { resolveWebObservedViewportStateGenericEffects } from './webObservedViewportStateGenericEffect';

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

describe('web observed viewport-state generic effects', () => {
    it('maps following-but-not-pinned web observations to generic observed-state effects', () => {
        expect(firstGenericObservedStateEffect(resolveWebObservedViewportStateGenericEffects({
            effect: {
                distanceFromLiveTailPx: 96,
                isPinned: false,
                pinnedOffsetThresholdPx: 72,
                sessionId: 'session-a',
                shouldRestoreViewport: false,
                type: 'web-observed-viewport-state',
                wantsPinned: true,
            },
            nextScrollOffsetPx: 424,
            pinEnabled: true,
        }))).toEqual({
            sessionId: 'session-a',
            state: {
                anchorCapture: {
                    suppressAnchorCapture: false,
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
                nextScrollOffsetPx: 424,
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

    it('maps released web observations to generic observed-state effects', () => {
        const effect = firstGenericObservedStateEffect(resolveWebObservedViewportStateGenericEffects({
            effect: {
                distanceFromLiveTailPx: 144,
                isPinned: false,
                pinnedOffsetThresholdPx: 0,
                sessionId: 'session-b',
                shouldRestoreViewport: true,
                type: 'web-observed-viewport-state',
                wantsPinned: false,
            },
            nextScrollOffsetPx: 128,
            pinEnabled: false,
        }));

        expect(effect.sessionId).toBe('session-b');
        expect(effect.state).toMatchObject({
            anchorCapture: {
                suppressAnchorCapture: false,
            },
            scrollPinEvent: {
                enabled: false,
                pinnedOffsetThresholdPx: 0,
            },
            viewportState: {
                isPinned: false,
                offsetY: 144,
                shouldRestoreViewport: true,
            },
            wantsPinned: false,
        });
    });
});
