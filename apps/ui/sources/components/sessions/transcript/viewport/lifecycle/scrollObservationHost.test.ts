import { describe, expect, it } from 'vitest';

import {
    createTranscriptLifecycleHost,
    type TranscriptLifecycleHostNativeScrollObservationInput,
} from './lifecycleHost';

const nativeScrollObservationInput = (
    overrides: Partial<TranscriptLifecycleHostNativeScrollObservationInput> = {},
): TranscriptLifecycleHostNativeScrollObservationInput => ({
    bottomFollowMode: 'following',
    contentHeightPx: 2400,
    distanceFromLiveTailForReleasePx: 180,
    distanceFromLiveTailPx: 180,
    entryRestoreConfirmedByObservation: false,
    hasOpenTrustedAwayGesture: false,
    hasRenderedItems: true,
    hasTrustedDragSession: false,
    isLoaded: true,
    isTrusted: false,
    isWarmKeepAliveInstance: false,
    lastNativePinOffset: null,
    layoutHeightPx: 800,
    movedAwayFromLiveTail: false,
    movedTowardLiveTail: false,
    nativeListDragActive: false,
    nativeMomentumScrollActive: false,
    nativeMountSettleDeadlineReached: false,
    nativeMountSettleStable: true,
    nowMs: 1300,
    pinEnabled: true,
    pinThresholdPx: 72,
    platform: 'native',
    pendingBottomPin: false,
    previousScrollOffsetPx: 640,
    recentUserIntent: false,
    scrollOffsetPx: 640,
    configuredBottomDistanceNoiseFloorPx: 4,
    hasNativeContentMeasurement: true,
    hasNativeInitialViewportApplied: true,
    lastUserScrollIntentAtMs: 0,
    sessionEntrySessionId: 'session-a',
    sessionEntryShouldFollowBottom: true,
    sessionId: 'session-a',
    userIntentRecentMs: 500,
    usesNativeFlashListBottomMaintenance: true,
    visualBottomScrollOffset: null,
    wantsPinned: true,
    ...overrides,
});

describe('transcript lifecycle host scroll observation planning', () => {
    it('plans web genuine upward movement through user-scroll, facts, and generic observation effects', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'web',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        const plan = host.observeScroll({
            distanceFromLiveTailPx: 180,
            isTrusted: false,
            movedAwayFromLiveTail: true,
            movedTowardLiveTail: false,
            nowMs: 1200,
            pinEnabled: true,
            pinThresholdPx: 72,
            platform: 'web',
            previousScrollOffsetPx: 640,
            scrollOffsetPx: 520,
            sessionId: 'session-a',
            webObservedUserScrollMovement: true,
            wantsPinned: true,
        });

        expect(plan.disposition).toBe('continue');
        expect(plan.steps.map((step) => step.type)).toEqual([
            'web-user-scroll',
            'web-scroll-facts',
            'web-generic-observation',
        ]);
        expect(plan.lifecycleEffects.map((effect) => effect.type)).toEqual([
            'web-user-scroll-preempt-entry-restore',
            'web-user-scroll-record-intent-timestamp',
            'web-release-live-tail',
        ]);
        expect(plan.genericEffects).toEqual([expect.objectContaining({
            state: expect.objectContaining({
                lastDistanceFromLiveTailPx: 180,
                wantsPinned: false,
            }),
            type: 'apply-generic-observed-viewport-state',
        })]);
    });

    it('does not emit web observation effects for non-genuine programmatic movement', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'web',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        const plan = host.observeScroll({
            distanceFromLiveTailPx: 180,
            isTrusted: false,
            movedAwayFromLiveTail: true,
            movedTowardLiveTail: false,
            nowMs: 1200,
            pinEnabled: true,
            pinThresholdPx: 72,
            platform: 'web',
            previousScrollOffsetPx: 640,
            scrollOffsetPx: 520,
            sessionId: 'session-a',
            webObservedUserScrollMovement: false,
            wantsPinned: true,
        });

        expect(plan).toMatchObject({
            disposition: 'ignored',
            genericEffects: [],
            lifecycleEffects: [],
            steps: [],
        });
    });

    it('requests bounded web passive live-tail correction for non-genuine drift while following', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'web',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        const plan = host.observeScroll({
            distanceFromLiveTailPx: 71,
            hasLiveWebMetrics: true,
            isTrusted: false,
            movedAwayFromLiveTail: false,
            movedTowardLiveTail: false,
            nowMs: 1200,
            pinEnabled: true,
            pinThresholdPx: 72,
            platform: 'web',
            previousScrollOffsetPx: 10053,
            scrollOffsetPx: 9982,
            sessionId: 'session-a',
            wantsPinned: true,
            webObservedUserScrollMovement: false,
        });

        expect(plan).toMatchObject({
            disposition: 'consumed',
            genericEffects: [],
            lifecycleEffects: [],
            state: {
                bottomFollowState: {
                    mode: 'following',
                },
            },
            webPassiveLiveTailCorrectionEffect: {
                reason: 'passive-drift',
                sessionId: 'session-a',
                type: 'apply-web-passive-live-tail-correction',
            },
        });
        expect(plan.steps.map((step) => step.type)).toEqual(['web-passive-live-tail-correction']);
    });

    it('corrects web passive drift BEYOND the pin threshold while follow intent is held (non-user writers can land far)', () => {
        // R3 root-cause family (live-captured 2026-07-08): a composer resize (~23px per line)
        // accumulates >72px of non-user drift in a few frames, and Legend-internal scroll
        // adjustments can land arbitrarily far in one frame. Release authority now lives in
        // the genuine-movement classifier (wantsPinned is authoritative): while follow intent
        // is held, a non-genuine observation beyond the threshold is by definition a non-user
        // writer's drift and MUST be corrected — the old `> pinThresholdPx` bail abandoned
        // exactly the drifts that most need healing.
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'web',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        const plan = host.observeScroll({
            distanceFromLiveTailPx: 135,
            hasLiveWebMetrics: true,
            isTrusted: false,
            movedAwayFromLiveTail: false,
            movedTowardLiveTail: false,
            nowMs: 1200,
            pinEnabled: true,
            pinThresholdPx: 72,
            platform: 'web',
            previousScrollOffsetPx: 5031,
            scrollOffsetPx: 4896,
            sessionId: 'session-a',
            wantsPinned: true,
            webObservedUserScrollMovement: false,
        });

        expect(plan.webPassiveLiveTailCorrectionEffect).toMatchObject({
            reason: 'passive-drift',
            sessionId: 'session-a',
            type: 'apply-web-passive-live-tail-correction',
        });
    });

    it('keeps tiny passive web live-tail offsets observable without correcting them', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'web',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        const plan = host.observeScroll({
            distanceFromLiveTailPx: 8,
            hasLiveWebMetrics: true,
            isTrusted: false,
            movedAwayFromLiveTail: false,
            movedTowardLiveTail: false,
            nowMs: 1200,
            pinEnabled: true,
            pinThresholdPx: 72,
            platform: 'web',
            previousScrollOffsetPx: 10053,
            scrollOffsetPx: 10045,
            sessionId: 'session-a',
            wantsPinned: true,
            webObservedUserScrollMovement: false,
        });

        expect(plan).toMatchObject({
            disposition: 'ignored',
            genericEffects: [],
            lifecycleEffects: [],
            state: {
                bottomFollowState: {
                    mode: 'following',
                },
            },
            webPassiveLiveTailCorrectionEffect: null,
        });
        expect(plan.steps).toEqual([]);
    });

    it('falls back to generic web viewport state when live web metrics are unavailable', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'web',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        const plan = host.observeScroll({
            distanceFromLiveTailPx: 180,
            hasLiveWebMetrics: false,
            isTrusted: false,
            movedAwayFromLiveTail: true,
            movedTowardLiveTail: false,
            nowMs: 1200,
            pinEnabled: true,
            pinThresholdPx: 72,
            platform: 'web',
            previousScrollOffsetPx: 640,
            recentUserIntent: true,
            scrollOffsetPx: 520,
            sessionId: 'session-a',
            wantsPinned: true,
            webObservedUserScrollMovement: false,
        });

        expect(plan.disposition).toBe('continue');
        expect(plan.steps.map((step) => step.type)).toEqual(['web-fallback']);
        expect(plan.lifecycleEffects).toEqual([]);
        expect(plan.genericEffects).toEqual([
            expect.objectContaining({
                state: expect.objectContaining({
                    anchorCapture: expect.objectContaining({
                        suppressAnchorCapture: true,
                    }),
                    lastDistanceFromLiveTailPx: 180,
                    wantsPinned: false,
                }),
                type: 'apply-generic-observed-viewport-state',
            }),
            {
                reason: 'web-no-live-metrics-fallback-release',
                sessionId: 'session-a',
                type: 'cancel-scheduled-viewport-anchor-capture',
            },
        ]);
    });

    it('records web user-scroll timing without taking over when genuine movement stays at live tail', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'web',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        const plan = host.observeScroll({
            distanceFromLiveTailPx: 0,
            isTrusted: false,
            movedAwayFromLiveTail: false,
            movedTowardLiveTail: true,
            nowMs: 1300,
            pinEnabled: true,
            pinThresholdPx: 72,
            platform: 'web',
            previousScrollOffsetPx: 520,
            scrollOffsetPx: 640,
            sessionId: 'session-a',
            webObservedUserScrollMovement: true,
            wantsPinned: true,
        });

        expect(plan.disposition).toBe('continue');
        expect(plan.steps.map((step) => step.type)).toEqual([
            'web-user-scroll',
            'web-scroll-facts',
            'web-generic-observation',
        ]);
        expect(plan.lifecycleEffects.map((effect) => effect.type)).toEqual([
            'web-user-scroll-record-intent-timestamp',
            'web-observed-viewport-state',
        ]);
        expect(plan.genericEffects).toEqual([expect.objectContaining({
            state: expect.objectContaining({
                lastDistanceFromLiveTailPx: 0,
                wantsPinned: true,
            }),
            type: 'apply-generic-observed-viewport-state',
        })]);
    });

    it('rearms web follow mode from trusted toward-tail facts without granting release authority', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'web',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });
        host.observeScroll({
            distanceFromLiveTailPx: 300,
            hasLiveWebMetrics: true,
            isTrusted: true,
            movedAwayFromLiveTail: true,
            movedTowardLiveTail: false,
            nowMs: 1200,
            pinEnabled: true,
            pinThresholdPx: 72,
            platform: 'web',
            previousScrollOffsetPx: 900,
            scrollOffsetPx: 600,
            sessionId: 'session-a',
            wantsPinned: true,
            webObservedUserScrollMovement: true,
        });

        const plan = host.observeScroll({
            distanceFromLiveTailPx: 50,
            hasLiveWebMetrics: true,
            isTrusted: true,
            movedAwayFromLiveTail: false,
            movedTowardLiveTail: true,
            nowMs: 1300,
            pinEnabled: true,
            pinThresholdPx: 72,
            platform: 'web',
            previousScrollOffsetPx: 600,
            scrollOffsetPx: 850,
            sessionId: 'session-a',
            wantsPinned: false,
            webObservedUserScrollMovement: false,
        });

        expect(plan.disposition).toBe('continue');
        expect(plan.steps.map((step) => step.type)).toEqual([
            'web-scroll-facts',
            'web-generic-observation',
        ]);
        expect(plan.lifecycleEffects.map((effect) => effect.type)).toEqual([
            'viewport-change',
            'drain-deferred-newer',
        ]);
        expect(plan.genericEffects).toEqual([expect.objectContaining({
            state: expect.objectContaining({
                lastDistanceFromLiveTailPx: 50,
                wantsPinned: true,
            }),
            type: 'apply-generic-observed-viewport-state',
        })]);
        expect(plan.state.bottomFollowState.mode).toBe('following');
    });

    it('plans native trusted movement away as follow intent, lifecycle release, accepted-paint check, and generic release', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });
        host.planNativeGestureStart({
            hasActiveNativeViewportRestore: false,
            sessionId: 'session-a',
            timestampMs: 1000,
        });

        const plan = host.observeScroll(nativeScrollObservationInput({
            bottomFollowMode: 'following',
            contentHeightPx: 2400,
            distanceFromLiveTailForReleasePx: 180,
            distanceFromLiveTailPx: 180,
            entryRestoreConfirmedByObservation: false,
            hasOpenTrustedAwayGesture: false,
            hasRenderedItems: true,
            hasTrustedDragSession: true,
            isLoaded: true,
            isTrusted: true,
            isWarmKeepAliveInstance: false,
            lastNativePinOffset: null,
            layoutHeightPx: 800,
            movedAwayFromLiveTail: true,
            movedTowardLiveTail: false,
            nativeListDragActive: true,
            nativeMomentumScrollActive: false,
            nativeMountSettleDeadlineReached: false,
            nativeMountSettleStable: true,
            nowMs: 1300,
            pinEnabled: true,
            pinThresholdPx: 72,
            platform: 'native',
            pendingBottomPin: false,
            previousScrollOffsetPx: 640,
            recentUserIntent: true,
            scrollOffsetPx: 520,
            configuredBottomDistanceNoiseFloorPx: 4,
            hasNativeContentMeasurement: true,
            hasNativeInitialViewportApplied: true,
            lastUserScrollIntentAtMs: 0,
            sessionEntrySessionId: 'session-a',
            sessionEntryShouldFollowBottom: true,
            sessionId: 'session-a',
            userIntentRecentMs: 500,
            usesNativeFlashListBottomMaintenance: true,
            visualBottomScrollOffset: null,
            wantsPinned: true,
        }));

        expect(plan.disposition).toBe('continue');
        expect(plan.steps.map((step) => step.type)).toEqual([
            'native-passive-observation',
            'native-follow-intent',
            'native-scroll-facts',
            'native-accepted-viewport-paint',
            'native-return-or-release',
        ]);
        expect(plan.followIntent).toMatchObject({
            released: true,
            wantsPinned: false,
        });
        expect(plan.lifecycleEffects).toEqual(expect.arrayContaining([
            expect.objectContaining({
                distanceFromLiveTailPx: 180,
                type: 'native-scroll-release-live-tail',
            }),
        ]));
        expect(plan.genericEffects).toEqual([expect.objectContaining({
            state: expect.objectContaining({
                lastDistanceFromLiveTailPx: 180,
                wantsPinned: false,
            }),
            type: 'apply-generic-observed-viewport-state',
        })]);
    });

    it('plans native settled return before observed-state fallback when a released reader reaches the live tail', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: false,
        });

        const plan = host.observeScroll(nativeScrollObservationInput({
            bottomFollowMode: 'released',
            contentHeightPx: 2400,
            distanceFromLiveTailForReleasePx: 24,
            distanceFromLiveTailPx: 24,
            entryRestoreConfirmedByObservation: false,
            hasOpenTrustedAwayGesture: false,
            hasRenderedItems: true,
            hasTrustedDragSession: true,
            isLoaded: true,
            isTrusted: true,
            isWarmKeepAliveInstance: false,
            lastNativePinOffset: null,
            layoutHeightPx: 800,
            movedAwayFromLiveTail: false,
            movedTowardLiveTail: true,
            nativeListDragActive: false,
            nativeMomentumScrollActive: false,
            nativeMountSettleDeadlineReached: false,
            nativeMountSettleStable: true,
            nowMs: 1300,
            pinEnabled: true,
            pinThresholdPx: 72,
            platform: 'native',
            pendingBottomPin: false,
            previousScrollOffsetPx: 520,
            recentUserIntent: true,
            scrollOffsetPx: 640,
            configuredBottomDistanceNoiseFloorPx: 4,
            hasNativeContentMeasurement: true,
            hasNativeInitialViewportApplied: true,
            lastUserScrollIntentAtMs: 0,
            sessionEntrySessionId: 'session-a',
            sessionEntryShouldFollowBottom: false,
            sessionId: 'session-a',
            userIntentRecentMs: 500,
            usesNativeFlashListBottomMaintenance: true,
            visualBottomScrollOffset: null,
            wantsPinned: false,
        }));

        expect(plan.disposition).toBe('continue');
        expect(plan.steps.map((step) => step.type)).toEqual([
            'native-passive-observation',
            'native-follow-intent',
            'native-scroll-facts',
            'native-accepted-viewport-paint',
            'native-settled-return',
        ]);
        expect(plan.nativeSettledReturnEffects?.returnEffects).toEqual([
            {
                distanceFromLiveTailPx: 24,
                sessionId: 'session-a',
                type: 'adopt-native-settled-return-to-live-tail',
            },
            {
                sessionId: 'session-a',
                type: 'capture-native-settled-return-anchor',
                viewportState: {
                    isPinned: true,
                    offsetY: 0,
                    shouldRestoreViewport: false,
                },
            },
        ]);
        expect(plan.nativeSettledReturnEffects?.drainEffects).toEqual([{
            distanceFromLiveTailPx: 24,
            isPinned: true,
            sessionId: 'session-a',
            type: 'drain-native-settled-return-to-live-tail',
        }]);
        expect(plan.genericEffects).toEqual([]);
    });

    it('consumes native read-only visible-bottom observations without persisting a viewport anchor', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: false,
        });

        const plan = host.observeScroll(nativeScrollObservationInput({
            bottomFollowMode: 'released',
            distanceFromLiveTailForReleasePx: 24,
            distanceFromLiveTailPx: 24,
            movedTowardLiveTail: true,
            scrollOffsetPx: 660,
            sessionEntryShouldFollowBottom: false,
        }));

        expect(plan.disposition).toBe('consumed');
        expect(plan.steps.map((step) => step.type)).toEqual([
            'native-passive-observation',
            'native-follow-intent',
            'native-read-only-visible-bottom',
        ]);
        expect(plan.lifecycleEffects).toEqual([]);
        expect(plan.genericEffects).toEqual([{
            sessionId: 'session-a',
            state: {
                jumpButtonDistanceFromLiveTailPx: 24,
                lastDistanceFromLiveTailPx: 24,
                scrollPinEvent: {
                    enabled: true,
                    offsetY: 24,
                    pinnedOffsetThresholdPx: 72,
                    type: 'scroll',
                },
            },
            type: 'apply-generic-read-only-visible-bottom-state',
        }]);
    });

    it('uses native generic fallback with anchor capture suppression for passive unpinned movement', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        const plan = host.observeScroll(nativeScrollObservationInput({
            bottomFollowMode: 'released',
            distanceFromLiveTailForReleasePx: 180,
            distanceFromLiveTailPx: 180,
            isTrusted: false,
            previousScrollOffsetPx: 640,
            scrollOffsetPx: 520,
            wantsPinned: false,
        }));

        expect(plan.disposition).toBe('continue');
        expect(plan.steps.map((step) => step.type)).toEqual([
            'native-passive-observation',
            'native-follow-intent',
            'native-accepted-viewport-paint',
            'generic-fallback',
        ]);
        expect(plan.nativeUserScrollTakeoverEffects).toEqual(expect.arrayContaining([
            expect.objectContaining({
                timestampMs: 1300,
                type: 'native-user-scroll-record-intent-timestamp',
            }),
        ]));
        expect(plan.genericEffects).toEqual([
            expect.objectContaining({
                state: expect.objectContaining({
                    anchorCapture: expect.objectContaining({
                        suppressAnchorCapture: true,
                    }),
                    lastDistanceFromLiveTailPx: 180,
                    wantsPinned: false,
                }),
                type: 'apply-generic-observed-viewport-state',
            }),
            {
                reason: 'native-passive-untrusted',
                sessionId: 'session-a',
                type: 'cancel-scheduled-viewport-anchor-capture',
            },
        ]);
    });

    it('cancels pending native anchor capture for passive unpinned movement without active trusted momentum', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: false,
        });

        const plan = host.observeScroll(nativeScrollObservationInput({
            bottomFollowMode: 'released',
            distanceFromLiveTailForReleasePx: 180,
            distanceFromLiveTailPx: 180,
            hasTrustedDragSession: true,
            previousScrollOffsetPx: 640,
            scrollOffsetPx: 520,
            wantsPinned: false,
        }));

        expect(plan.genericEffects).toEqual([
            expect.objectContaining({
                state: expect.objectContaining({
                    anchorCapture: expect.objectContaining({
                        suppressAnchorCapture: true,
                    }),
                    lastDistanceFromLiveTailPx: 180,
                    wantsPinned: false,
                }),
                type: 'apply-generic-observed-viewport-state',
            }),
            {
                reason: 'native-passive-untrusted',
                sessionId: 'session-a',
                type: 'cancel-scheduled-viewport-anchor-capture',
            },
        ]);
    });

    it('plans skipped passive native scroll telemetry and consumes before generic observation', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: false,
        });

        const plan = host.observeScroll(nativeScrollObservationInput({
            distanceFromLiveTailForReleasePx: 0,
            distanceFromLiveTailPx: 0,
            hasNativeContentMeasurement: false,
            hasNativeInitialViewportApplied: false,
            sessionEntryShouldFollowBottom: false,
            wantsPinned: false,
        }));

        expect(plan.disposition).toBe('continue');
        expect(plan.steps.map((step) => step.type)).toEqual(['native-passive-observation']);
        expect(plan.nativePassiveScrollObservationEffect).toEqual({
            consumeAfterBottomCompletion: true,
            markInitialViewportApplied: false,
            reason: 'skipped',
            sessionId: 'session-a',
            type: 'record-native-passive-scroll-observation',
        });
        expect(plan.nativeUserScrollTakeoverEffects).toEqual([]);
        expect(plan.genericEffects).toEqual([]);
    });

    it('returns native bottom-follow completion effects when a pinned native observation reaches bottom', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        const plan = host.observeScroll(nativeScrollObservationInput({
            distanceFromLiveTailForReleasePx: 0,
            distanceFromLiveTailPx: 0,
            lastNativePinOffset: 1600,
            previousScrollOffsetPx: 1600,
            scrollOffsetPx: 1600,
            visualBottomScrollOffset: 1600,
        }));

        expect(plan).toMatchObject({
            nativeBottomFollowCompletionEffects: [{
                entrySettleBaselineContentHeight: 2400,
                sessionId: 'session-a',
                type: 'complete-native-bottom-follow',
            }],
        });
    });

    it('holds native bottom-follow completion while the pending mount-settle pin target is unresolved', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        const plan = host.observeScroll(nativeScrollObservationInput({
            distanceFromLiveTailForReleasePx: 0,
            distanceFromLiveTailPx: 0,
            lastNativePinOffset: 700,
            nativeMountSettleStable: false,
            pendingBottomPin: true,
            previousScrollOffsetPx: 1000,
            scrollOffsetPx: 1000,
            visualBottomScrollOffset: 1000,
        }));

        expect(plan).toMatchObject({
            nativeBottomFollowCompletionEffects: [],
        });
    });

    it('plans passive unpinned native movement as observed user intent and suppresses anchor capture', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: false,
        });

        const plan = host.observeScroll(nativeScrollObservationInput({
            bottomFollowMode: 'released',
            distanceFromLiveTailForReleasePx: 180,
            distanceFromLiveTailPx: 180,
            previousScrollOffsetPx: 640,
            scrollOffsetPx: 520,
            wantsPinned: false,
        }));

        expect(plan.nativePassiveScrollObservationEffect).toEqual({
            consumeAfterBottomCompletion: false,
            markInitialViewportApplied: false,
            reason: 'observed',
            sessionId: 'session-a',
            type: 'record-native-passive-scroll-observation',
        });
        expect(plan.nativeUserScrollTakeoverEffects).toEqual(expect.arrayContaining([
            expect.objectContaining({
                timestampMs: 1300,
                type: 'native-user-scroll-record-intent-timestamp',
            }),
        ]));
        expect(plan.genericEffects).toEqual([
            expect.objectContaining({
                state: expect.objectContaining({
                    anchorCapture: expect.objectContaining({
                        suppressAnchorCapture: true,
                    }),
                    lastDistanceFromLiveTailPx: 180,
                    wantsPinned: false,
                }),
                type: 'apply-generic-observed-viewport-state',
            }),
            {
                reason: 'native-passive-untrusted',
                sessionId: 'session-a',
                type: 'cancel-scheduled-viewport-anchor-capture',
            },
        ]);
    });

    it('refreshes recent passive native user intent through lifecycle effects without skipping observation', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        const plan = host.observeScroll(nativeScrollObservationInput({
            distanceFromLiveTailForReleasePx: 0,
            distanceFromLiveTailPx: 0,
            lastUserScrollIntentAtMs: 1100,
            scrollOffsetPx: 660,
            wantsPinned: true,
        }));

        expect(plan.nativePassiveScrollObservationEffect).toEqual({
            consumeAfterBottomCompletion: false,
            markInitialViewportApplied: false,
            reason: 'observed',
            sessionId: 'session-a',
            type: 'record-native-passive-scroll-observation',
        });
        expect(plan.nativeUserScrollTakeoverEffects).toEqual(expect.arrayContaining([
            expect.objectContaining({
                timestampMs: 1300,
                type: 'native-user-scroll-record-intent-timestamp',
            }),
        ]));
    });

    it('consumes native open trusted away gesture bail before generic fallback', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        const plan = host.observeScroll(nativeScrollObservationInput({
            bottomFollowMode: 'following',
            contentHeightPx: 2400,
            distanceFromLiveTailForReleasePx: 24,
            distanceFromLiveTailPx: 24,
            entryRestoreConfirmedByObservation: false,
            hasOpenTrustedAwayGesture: true,
            hasRenderedItems: true,
            hasTrustedDragSession: true,
            isLoaded: true,
            isTrusted: false,
            isWarmKeepAliveInstance: false,
            lastNativePinOffset: null,
            layoutHeightPx: 800,
            movedAwayFromLiveTail: true,
            movedTowardLiveTail: false,
            nativeListDragActive: true,
            nativeMomentumScrollActive: false,
            nativeMountSettleDeadlineReached: false,
            nativeMountSettleStable: true,
            nowMs: 1300,
            pinEnabled: true,
            pinThresholdPx: 72,
            platform: 'native',
            pendingBottomPin: false,
            previousScrollOffsetPx: 640,
            recentUserIntent: true,
            scrollOffsetPx: 520,
            configuredBottomDistanceNoiseFloorPx: 4,
            hasNativeContentMeasurement: true,
            hasNativeInitialViewportApplied: true,
            lastUserScrollIntentAtMs: 0,
            sessionEntrySessionId: 'session-a',
            sessionEntryShouldFollowBottom: true,
            sessionId: 'session-a',
            userIntentRecentMs: 500,
            usesNativeFlashListBottomMaintenance: true,
            visualBottomScrollOffset: null,
            wantsPinned: false,
        }));

        expect(plan.disposition).toBe('consumed');
        expect(plan.steps.map((step) => step.type)).toEqual([
            'native-passive-observation',
            'native-scroll-facts',
            'native-away-gesture-live-tail-bail',
            'consume-observation',
        ]);
        expect(plan.steps.map((step) => step.type)).not.toContain('generic-fallback');
        expect(plan.genericEffects).toEqual([]);
    });

    it('consumes native passive drift with suppression instead of generic released state', () => {
        const host = createTranscriptLifecycleHost();
        host.enterSession({
            platform: 'native',
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
        });

        const plan = host.observeScroll(nativeScrollObservationInput({
            bottomFollowMode: 'following',
            contentHeightPx: 2400,
            distanceFromLiveTailForReleasePx: 180,
            distanceFromLiveTailPx: 180,
            entryRestoreConfirmedByObservation: false,
            hasOpenTrustedAwayGesture: false,
            hasRenderedItems: true,
            hasTrustedDragSession: false,
            isLoaded: true,
            isTrusted: false,
            isWarmKeepAliveInstance: false,
            lastNativePinOffset: null,
            layoutHeightPx: 800,
            movedAwayFromLiveTail: true,
            movedTowardLiveTail: false,
            nativeListDragActive: false,
            nativeMomentumScrollActive: false,
            nativeMountSettleDeadlineReached: false,
            nativeMountSettleStable: true,
            nowMs: 1300,
            pinEnabled: true,
            pinThresholdPx: 72,
            platform: 'native',
            pendingBottomPin: false,
            previousScrollOffsetPx: 640,
            recentUserIntent: false,
            scrollOffsetPx: 520,
            configuredBottomDistanceNoiseFloorPx: 4,
            hasNativeContentMeasurement: true,
            hasNativeInitialViewportApplied: true,
            lastUserScrollIntentAtMs: 0,
            sessionEntrySessionId: 'session-a',
            sessionEntryShouldFollowBottom: true,
            sessionId: 'session-a',
            userIntentRecentMs: 500,
            usesNativeFlashListBottomMaintenance: true,
            visualBottomScrollOffset: null,
            wantsPinned: true,
        }));

        expect(plan.disposition).toBe('consumed');
        expect(plan.steps.map((step) => step.type)).toEqual([
            'native-passive-observation',
            'native-follow-intent',
            'native-passive-drift-bail',
        ]);
        expect(plan.genericEffects).toEqual([{
            reason: 'native-passive-drift',
            sessionId: 'session-a',
            type: 'suppress-generic-scroll-observation',
        }]);
    });
});
