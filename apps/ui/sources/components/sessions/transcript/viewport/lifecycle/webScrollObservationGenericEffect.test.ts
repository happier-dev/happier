import { describe, expect, it } from 'vitest';

import type { TranscriptViewportLifecycleEffect } from './lifecycle';
import { resolveWebObservedViewportStateGenericEffects } from './webObservedViewportStateGenericEffect';
import { resolveWebReleaseLiveTailGenericEffects } from './webReleaseLiveTailGenericEffect';
import { resolveWebScrollObservationGenericLifecycleEffects } from './webScrollObservationGenericEffect';
import { resolveWebSettledReturnGenericEffects } from './webSettledReturnGenericEffect';

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

const releaseEffect = {
    distanceFromLiveTailPx: 180,
    isPinned: false,
    sessionId: 'session-a',
    type: 'web-release-live-tail',
} as const satisfies TranscriptViewportLifecycleEffect;

const observedEffect = {
    distanceFromLiveTailPx: 96,
    isPinned: false,
    pinnedOffsetThresholdPx: 72,
    sessionId: 'session-a',
    shouldRestoreViewport: false,
    type: 'web-observed-viewport-state',
    wantsPinned: true,
} as const satisfies TranscriptViewportLifecycleEffect;

describe('web scroll-observation generic lifecycle effects', () => {
    it('returns no generic effects when none match the current session', () => {
        expect(resolveWebScrollObservationGenericLifecycleEffects({
            effects: [],
            nextScrollOffsetPx: 512,
            pinEnabled: true,
            pinnedOffsetThresholdPx: 72,
            sessionId: 'session-a',
        })).toEqual([]);

        expect(resolveWebScrollObservationGenericLifecycleEffects({
            effects: [
                { ...viewportEffect, sessionId: 'session-b' },
                { ...drainEffect, sessionId: 'session-b' },
                { ...releaseEffect, sessionId: 'session-b' },
                { ...observedEffect, sessionId: 'session-b' },
            ],
            nextScrollOffsetPx: 512,
            pinEnabled: true,
            pinnedOffsetThresholdPx: 72,
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('projects a current-session settled return pair through the existing settled-return mapper', () => {
        expect(resolveWebScrollObservationGenericLifecycleEffects({
            effects: [viewportEffect, drainEffect],
            nextScrollOffsetPx: 512,
            pinEnabled: true,
            pinnedOffsetThresholdPx: 72,
            sessionId: 'session-a',
        })).toEqual(resolveWebSettledReturnGenericEffects({
            drainEffect,
            nextScrollOffsetPx: 512,
            pinEnabled: true,
            pinnedOffsetThresholdPx: 72,
            viewportEffect,
        }));
    });

    it('keeps settled return ahead of release and observed state when all are present', () => {
        expect(resolveWebScrollObservationGenericLifecycleEffects({
            effects: [observedEffect, releaseEffect, viewportEffect, drainEffect],
            nextScrollOffsetPx: 512,
            pinEnabled: true,
            pinnedOffsetThresholdPx: 72,
            sessionId: 'session-a',
        })).toEqual(resolveWebSettledReturnGenericEffects({
            drainEffect,
            nextScrollOffsetPx: 512,
            pinEnabled: true,
            pinnedOffsetThresholdPx: 72,
            viewportEffect,
        }));
    });

    it('falls through an unmatched settled return pair to release or observed state', () => {
        expect(resolveWebScrollObservationGenericLifecycleEffects({
            effects: [
                viewportEffect,
                { ...drainEffect, distanceFromLiveTailPx: 13 },
                observedEffect,
                releaseEffect,
            ],
            nextScrollOffsetPx: 256,
            pinEnabled: false,
            pinnedOffsetThresholdPx: 72,
            sessionId: 'session-a',
        })).toEqual(resolveWebReleaseLiveTailGenericEffects({
            effect: releaseEffect,
            nextScrollOffsetPx: 256,
            pinEnabled: false,
        }));

        expect(resolveWebScrollObservationGenericLifecycleEffects({
            effects: [
                viewportEffect,
                { ...drainEffect, distanceFromLiveTailPx: 13 },
                observedEffect,
            ],
            nextScrollOffsetPx: 128,
            pinEnabled: true,
            pinnedOffsetThresholdPx: 72,
            sessionId: 'session-a',
        })).toEqual(resolveWebObservedViewportStateGenericEffects({
            effect: observedEffect,
            nextScrollOffsetPx: 128,
            pinEnabled: true,
        }));
    });

    it('keeps release ahead of observed state and preserves the release threshold behavior', () => {
        const effects = resolveWebScrollObservationGenericLifecycleEffects({
            effects: [observedEffect, releaseEffect],
            nextScrollOffsetPx: 64,
            pinEnabled: true,
            pinnedOffsetThresholdPx: 72,
            sessionId: 'session-a',
        });

        expect(effects).toEqual(resolveWebReleaseLiveTailGenericEffects({
            effect: releaseEffect,
            nextScrollOffsetPx: 64,
            pinEnabled: true,
        }));
        expect(effects[0]).toMatchObject({
            state: {
                scrollPinEvent: {
                    pinnedOffsetThresholdPx: 0,
                },
            },
        });
    });

    it('uses observed state when there is no settled return or release effect', () => {
        expect(resolveWebScrollObservationGenericLifecycleEffects({
            effects: [observedEffect],
            nextScrollOffsetPx: 32,
            pinEnabled: false,
            pinnedOffsetThresholdPx: 72,
            sessionId: 'session-a',
        })).toEqual(resolveWebObservedViewportStateGenericEffects({
            effect: observedEffect,
            nextScrollOffsetPx: 32,
            pinEnabled: false,
        }));
    });

    it('ignores mixed native, takeover, session-entry, and generic effects', () => {
        expect(resolveWebScrollObservationGenericLifecycleEffects({
            effects: [
                {
                    distanceFromLiveTailPx: 40,
                    isPinned: false,
                    sessionId: 'session-a',
                    type: 'native-scroll-release-live-tail',
                },
                {
                    reason: 'jump-to-seq',
                    sessionId: 'session-a',
                    type: 'explicit-jump-preempt-entry-restore',
                },
                {
                    sessionId: 'session-a',
                    type: 'follow-bottom-intent-preempt-entry-restore',
                },
                {
                    distanceFromLiveTailPx: 12,
                    isPinned: false,
                    sessionId: 'session-a',
                    shouldRestoreViewport: true,
                    type: 'session-entry-viewport',
                },
                {
                    sessionId: 'session-a',
                    state: {
                        anchorCapture: {
                            suppressAnchorCapture: false,
                            viewportState: {
                                isPinned: true,
                                offsetY: 0,
                                shouldRestoreViewport: false,
                            },
                        },
                        drain: {
                            distanceFromLiveTailPx: 0,
                            isPinned: true,
                        },
                        jumpButtonDistanceFromLiveTailPx: 0,
                        lastDistanceFromLiveTailPx: 0,
                        nextScrollOffsetPx: 0,
                        scrollPinEvent: {
                            enabled: true,
                            offsetY: 0,
                            pinnedOffsetThresholdPx: 72,
                            type: 'scroll',
                        },
                        viewportState: {
                            isPinned: true,
                            offsetY: 0,
                            shouldRestoreViewport: false,
                        },
                        wantsPinned: true,
                    },
                    type: 'apply-generic-observed-viewport-state',
                },
            ],
            nextScrollOffsetPx: 32,
            pinEnabled: true,
            pinnedOffsetThresholdPx: 72,
            sessionId: 'session-a',
        })).toEqual([]);
    });
});
