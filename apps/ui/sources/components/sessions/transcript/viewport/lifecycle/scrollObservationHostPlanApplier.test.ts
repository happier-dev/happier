import { describe, expect, it } from 'vitest';

import { createTranscriptViewportLifecycle } from './lifecycle';
import {
    applyScrollObservationHostPlan,
    type ScrollObservationHostPlanApplierCallbacks,
} from './scrollObservationHostPlanApplier';
import type { TranscriptScrollObservationHostPlan } from './scrollObservationHost';

const sessionId = 'session-a';

const createPlan = (
    overrides: Partial<TranscriptScrollObservationHostPlan> = {},
): TranscriptScrollObservationHostPlan => ({
    acceptedViewportPaintEffects: overrides.acceptedViewportPaintEffects ?? [],
    disposition: overrides.disposition ?? 'continue',
    followIntent: overrides.followIntent ?? null,
    genericEffects: overrides.genericEffects ?? [],
    lifecycleEffects: overrides.lifecycleEffects ?? [],
    nativeBottomFollowCompletionEffects: overrides.nativeBottomFollowCompletionEffects ?? [],
    nativePassiveScrollObservationEffect: overrides.nativePassiveScrollObservationEffect ?? null,
    nativeSettledReturnEffects: overrides.nativeSettledReturnEffects ?? null,
    nativeUserScrollTakeoverEffects: overrides.nativeUserScrollTakeoverEffects ?? [],
    recentUserIntent: overrides.recentUserIntent ?? false,
    state: overrides.state ?? createTranscriptViewportLifecycle().getState(),
    steps: overrides.steps ?? [],
    webPassiveLiveTailCorrectionEffect: overrides.webPassiveLiveTailCorrectionEffect ?? null,
});

const callbacksRecording = (order: string[]): ScrollObservationHostPlanApplierCallbacks => ({
    applyGenericScrollObservationAnchorCaptureCancellationEffects() {
        order.push('anchor-cancel');
        return false;
    },
    applyGenericScrollObservationReadOnlyVisibleBottomEffects() {
        order.push('read-only');
        return false;
    },
    applyGenericScrollObservationSuppressionEffects() {
        order.push('suppression');
        return false;
    },
    applyGenericScrollObservationViewportStateEffects() {
        order.push('generic');
        return false;
    },
    applyNativeAcceptedViewportPaintEffects() {
        order.push('accepted-paint');
        return true;
    },
    applyNativeBottomFollowCompletionEffects() {
        order.push('bottom-follow-completion');
    },
    applyNativeSettledReturnToLiveTailDrainEffects() {
        order.push('settled-drain');
    },
    applyNativeSettledReturnToLiveTailReturnEffects() {
        order.push('settled-return');
        return true;
    },
    applyNativeUserScrollTakeoverApplyEffects() {
        order.push('native-user-takeover');
    },
    applyWebUserScrollIntentTimestampLifecycleEffects() {
        order.push('web-intent-timestamp');
    },
    applyWebPassiveLiveTailCorrectionEffect(effect) {
        order.push(`web-passive-correction:${effect.reason}`);
        return true;
    },
    applyWebUserScrollTakeoverLifecycleEffects() {
        order.push('web-takeover');
    },
    commitViewportLifecycleState() {
        order.push('commit-state');
    },
    markNativeInitialViewportApplied() {
        order.push('mark-initial-viewport');
    },
    recordNativeScrollObservation(reason) {
        order.push(`passive:${reason}`);
    },
});

describe('scroll observation host plan applier', () => {
    it('applies passive native effects before continuation and committed observation effects', () => {
        const order: string[] = [];

        const consumed = applyScrollObservationHostPlan({
            callbacks: callbacksRecording(order),
            continueAfterEarlyScrollObservation(continuation) {
                order.push(
                    `continue:${continuation.recentUserIntent}:${continuation.shouldApplyNativeMountSettlePassiveDriftRepinObservation}`,
                );
            },
            plan: createPlan({
                acceptedViewportPaintEffects: [{
                    fallbackMetrics: {
                        contentHeight: 2400,
                        distanceFromLiveTailPx: 0,
                        layoutHeight: 800,
                    },
                    sessionId,
                    type: 'record-accepted-viewport-paint',
                }],
                genericEffects: [{
                    reason: 'native-passive-drift',
                    sessionId,
                    type: 'suppress-generic-scroll-observation',
                }],
                lifecycleEffects: [{
                    sessionId,
                    timestampMs: 2000,
                    type: 'web-user-scroll-record-intent-timestamp',
                }],
                nativeBottomFollowCompletionEffects: [{
                    entrySettleBaselineContentHeight: 2400,
                    sessionId,
                    type: 'complete-native-bottom-follow',
                }],
                nativePassiveScrollObservationEffect: {
                    consumeAfterBottomCompletion: false,
                    markInitialViewportApplied: true,
                    reason: 'observed',
                    sessionId,
                    type: 'record-native-passive-scroll-observation',
                },
                nativeSettledReturnEffects: {
                    drainEffects: [{
                        distanceFromLiveTailPx: 0,
                        isPinned: true,
                        sessionId,
                        type: 'drain-native-settled-return-to-live-tail',
                    }],
                    returnEffects: [{
                        distanceFromLiveTailPx: 0,
                        sessionId,
                        type: 'adopt-native-settled-return-to-live-tail',
                    }],
                },
                nativeUserScrollTakeoverEffects: [{
                    sessionId,
                    timestampMs: 2000,
                    type: 'native-user-scroll-record-intent-timestamp',
                }],
                recentUserIntent: true,
                steps: [{
                    genericEffects: [],
                    type: 'native-passive-drift-bail',
                }],
            }),
            recentUserIntentBeforeObservation: false,
        });

        expect(consumed).toBe(true);
        expect(order).toEqual([
            'passive:observed',
            'bottom-follow-completion',
            'native-user-takeover',
            'mark-initial-viewport',
            'continue:true:true',
            'commit-state',
            'web-takeover',
            'web-intent-timestamp',
            'accepted-paint',
            'settled-return',
            'settled-drain',
            'generic',
            'read-only',
            'suppression',
            'anchor-cancel',
        ]);
    });

    it('stops before continuation and state commit when native passive observation consumes the frame', () => {
        const order: string[] = [];

        const consumed = applyScrollObservationHostPlan({
            callbacks: callbacksRecording(order),
            continueAfterEarlyScrollObservation() {
                order.push('continue');
            },
            plan: createPlan({
                nativeBottomFollowCompletionEffects: [{
                    entrySettleBaselineContentHeight: 2400,
                    sessionId,
                    type: 'complete-native-bottom-follow',
                }],
                nativePassiveScrollObservationEffect: {
                    consumeAfterBottomCompletion: true,
                    markInitialViewportApplied: false,
                    reason: 'skipped',
                    sessionId,
                    type: 'record-native-passive-scroll-observation',
                },
                nativeUserScrollTakeoverEffects: [{
                    sessionId,
                    type: 'native-user-scroll-preempt-entry-restore',
                }],
                recentUserIntent: true,
            }),
            recentUserIntentBeforeObservation: false,
        });

        expect(consumed).toBe(true);
        expect(order).toEqual([
            'passive:skipped',
            'bottom-follow-completion',
            'native-user-takeover',
        ]);
    });

    it('uses the pre-observation recent intent for web continuation without native-only callbacks', () => {
        const order: string[] = [];

        const consumed = applyScrollObservationHostPlan({
            callbacks: callbacksRecording(order),
            continueAfterEarlyScrollObservation(continuation) {
                order.push(
                    `continue:${continuation.recentUserIntent}:${continuation.shouldApplyNativeMountSettlePassiveDriftRepinObservation}`,
                );
            },
            plan: createPlan({
                lifecycleEffects: [{
                    sessionId,
                    type: 'web-user-scroll-preempt-entry-restore',
                }, {
                    sessionId,
                    timestampMs: 2000,
                    type: 'web-user-scroll-record-intent-timestamp',
                }],
            }),
            recentUserIntentBeforeObservation: true,
        });

        expect(consumed).toBe(false);
        expect(order).toEqual([
            'continue:true:false',
            'commit-state',
            'web-takeover',
            'web-intent-timestamp',
            'generic',
            'read-only',
            'suppression',
            'anchor-cancel',
        ]);
    });

    it('applies web passive live-tail correction before generic observation effects', () => {
        const order: string[] = [];
        const callbacks = {
            ...callbacksRecording(order),
            applyWebPassiveLiveTailCorrectionEffect(effect: { reason: string }) {
                order.push(`web-passive-correction:${effect.reason}`);
                return true;
            },
        };

        const consumed = applyScrollObservationHostPlan({
            callbacks,
            continueAfterEarlyScrollObservation(continuation) {
                order.push(
                    `continue:${continuation.recentUserIntent}:${continuation.shouldApplyNativeMountSettlePassiveDriftRepinObservation}`,
                );
            },
            plan: createPlan({
                disposition: 'consumed',
                steps: [{
                    effect: {
                        reason: 'passive-drift',
                        sessionId,
                        type: 'apply-web-passive-live-tail-correction',
                    },
                    type: 'web-passive-live-tail-correction',
                }],
                webPassiveLiveTailCorrectionEffect: {
                    reason: 'passive-drift',
                    sessionId,
                    type: 'apply-web-passive-live-tail-correction',
                },
            } as Partial<TranscriptScrollObservationHostPlan>),
            recentUserIntentBeforeObservation: false,
        });

        expect(consumed).toBe(true);
        expect(order).toEqual([
            'continue:false:false',
            'commit-state',
            'web-takeover',
            'web-intent-timestamp',
            'web-passive-correction:passive-drift',
            'generic',
            'read-only',
            'suppression',
            'anchor-cancel',
        ]);
    });

    it('treats generic viewport-state consumption as the plan result', () => {
        const order: string[] = [];
        const callbacks = {
            ...callbacksRecording(order),
            applyGenericScrollObservationViewportStateEffects(
                ...args: Parameters<ScrollObservationHostPlanApplierCallbacks['applyGenericScrollObservationViewportStateEffects']>
            ) {
                order.push('generic');
                args[1]?.recordAcceptedViewportPaintObservation();
                return true;
            },
        } satisfies ScrollObservationHostPlanApplierCallbacks;

        const consumed = applyScrollObservationHostPlan({
            callbacks,
            continueAfterEarlyScrollObservation(continuation) {
                order.push(
                    `continue:${continuation.recentUserIntent}:${continuation.shouldApplyNativeMountSettlePassiveDriftRepinObservation}`,
                );
            },
            plan: createPlan({
                acceptedViewportPaintEffects: [{
                    fallbackMetrics: {
                        contentHeight: 2400,
                        distanceFromLiveTailPx: 0,
                        layoutHeight: 800,
                    },
                    sessionId,
                    type: 'record-accepted-viewport-paint',
                }],
                genericEffects: [{
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
                        nextScrollOffsetPx: 1600,
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
                    sessionId,
                    type: 'apply-generic-observed-viewport-state',
                }],
            }),
            recentUserIntentBeforeObservation: false,
        });

        expect(consumed).toBe(true);
        expect(order).toEqual([
            'continue:false:false',
            'commit-state',
            'web-takeover',
            'web-intent-timestamp',
            'generic',
            'accepted-paint',
            'read-only',
            'suppression',
            'anchor-cancel',
        ]);
    });
});
