import { describe, expect, it } from 'vitest';

import type { TranscriptLifecycleHostScrollObservationPlan } from './lifecycleHost';
import {
    applyTranscriptLifecycleScrollObservationPlan,
    type TranscriptLifecycleScrollObservationPlanApplierEffects,
} from './lifecycleHostScrollObservationApplier';

const lifecycleState: TranscriptLifecycleHostScrollObservationPlan['state'] = {
    automaticPinAuthority: true,
    bottomFollowState: {
        dragSession: null,
        mode: 'following',
    },
    fingerDown: false,
    followMode: 'following',
    gesturePhase: 'settled',
    sessionId: 'session-a',
};

const nativeUserScrollEffect: TranscriptLifecycleHostScrollObservationPlan['nativeUserScrollTakeoverEffects'][number] = {
    sessionId: 'session-a',
    timestampMs: 1300,
    type: 'native-user-scroll-record-intent-timestamp',
};

const bottomFollowCompletionEffect: TranscriptLifecycleHostScrollObservationPlan['nativeBottomFollowCompletionEffects'][number] = {
    entrySettleBaselineContentHeight: 2400,
    sessionId: 'session-a',
    type: 'complete-native-bottom-follow',
};

const acceptedPaintEffect: TranscriptLifecycleHostScrollObservationPlan['acceptedViewportPaintEffects'][number] = {
    fallbackMetrics: {
        contentHeight: 2400,
        distanceFromLiveTailPx: 0,
        layoutHeight: 800,
    },
    sessionId: 'session-a',
    type: 'record-accepted-viewport-paint',
};

const genericViewportEffect: TranscriptLifecycleHostScrollObservationPlan['genericEffects'][number] = {
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
    type: 'apply-generic-observed-viewport-state',
};

function scrollObservationPlan(
    overrides: Partial<TranscriptLifecycleHostScrollObservationPlan> = {},
): TranscriptLifecycleHostScrollObservationPlan {
    return {
        acceptedViewportPaintEffects: [],
        disposition: 'continue',
        followIntent: null,
        genericEffects: [],
        lifecycleEffects: [],
        nativeBottomFollowCompletionEffects: [],
        nativePassiveScrollObservationEffect: null,
        nativeSettledReturnEffects: null,
        nativeUserScrollTakeoverEffects: [],
        recentUserIntent: false,
        state: lifecycleState,
        steps: [],
        webPassiveLiveTailCorrectionEffect: null,
        ...overrides,
    };
}

function effectsRecorder(log: string[]): TranscriptLifecycleScrollObservationPlanApplierEffects {
    return {
        applyGenericScrollObservationAnchorCaptureCancellationEffects(effects) {
            log.push(`anchor-cancel:${effects.length}`);
            return false;
        },
        applyGenericScrollObservationReadOnlyVisibleBottomEffects(effects) {
            log.push(`read-only:${effects.length}`);
            return false;
        },
        applyGenericScrollObservationSuppressionEffects(effects) {
            log.push(`suppress:${effects.length}`);
            return false;
        },
        applyGenericScrollObservationViewportStateEffects(effects, options) {
            log.push(`generic-start:${effects.length}`);
            if (effects.length > 0) {
                options.recordAcceptedViewportPaintObservation();
            }
            log.push(`generic-end:${effects.length}`);
            return effects.length > 0;
        },
        applyNativeAcceptedViewportPaintEffects(effects) {
            log.push(`accepted-paint:${effects.length}`);
        },
        applyNativeBottomFollowCompletionEffects(effects) {
            log.push(`bottom-follow:${effects.length}`);
        },
        applyNativeSettledReturnToLiveTailDrainEffects(effects) {
            log.push(`settled-drain:${effects.length}`);
        },
        applyNativeSettledReturnToLiveTailReturnEffects(effects) {
            log.push(`settled-return:${effects.length}`);
            return effects.length > 0;
        },
        applyNativeUserScrollTakeoverEffects(effects) {
            log.push(`native-user:${effects.length}`);
        },
        applyWebUserScrollIntentTimestampLifecycleEffects(effects) {
            log.push(`web-timestamp:${effects.length}`);
        },
        applyWebPassiveLiveTailCorrectionEffect(effect) {
            log.push(`web-passive-correction:${effect.reason}`);
            return true;
        },
        applyWebUserScrollTakeoverLifecycleEffects(effects) {
            log.push(`web-takeover:${effects.length}`);
        },
        commitBottomFollowModeState(state) {
            log.push(`commit:${state.mode}`);
        },
        continueAfterEarlyEffects(input) {
            log.push(
                `continue:${input.recentUserIntent}:${input.hasNativeMountSettlePassiveDriftRepinObservation}`,
            );
        },
        markNativeInitialViewportApplied() {
            log.push('mark-initial');
        },
        recordNativeScrollObservation(reason) {
            log.push(`record-native:${reason}`);
        },
    };
}

describe('lifecycle host scroll-observation plan applier', () => {
    it('applies native passive, bottom-follow, and user-scroll effects before consuming the frame', () => {
        const log: string[] = [];
        const consumed = applyTranscriptLifecycleScrollObservationPlan(
            scrollObservationPlan({
                genericEffects: [genericViewportEffect],
                nativeBottomFollowCompletionEffects: [bottomFollowCompletionEffect],
                nativePassiveScrollObservationEffect: {
                    consumeAfterBottomCompletion: true,
                    markInitialViewportApplied: true,
                    reason: 'skipped',
                    sessionId: 'session-a',
                    type: 'record-native-passive-scroll-observation',
                },
                nativeUserScrollTakeoverEffects: [nativeUserScrollEffect],
            }),
            effectsRecorder(log),
        );

        expect(consumed).toBe(true);
        expect(log).toEqual([
            'record-native:skipped',
            'bottom-follow:1',
            'native-user:1',
            'mark-initial',
        ]);
    });

    it('runs the host continuation between early native effects and late lifecycle effects', () => {
        const log: string[] = [];
        const consumed = applyTranscriptLifecycleScrollObservationPlan(
            scrollObservationPlan({
                nativeBottomFollowCompletionEffects: [bottomFollowCompletionEffect],
                nativePassiveScrollObservationEffect: {
                    consumeAfterBottomCompletion: false,
                    markInitialViewportApplied: false,
                    reason: 'observed',
                    sessionId: 'session-a',
                    type: 'record-native-passive-scroll-observation',
                },
                nativeUserScrollTakeoverEffects: [nativeUserScrollEffect],
                recentUserIntent: true,
                steps: [{
                    acceptedViewportPaintEffects: [],
                    genericEffects: [],
                    type: 'generic-fallback',
                }],
            }),
            effectsRecorder(log),
        );

        expect(consumed).toBe(false);
        expect(log).toEqual([
            'record-native:observed',
            'bottom-follow:1',
            'native-user:1',
            'continue:true:true',
            'commit:following',
            'web-takeover:0',
            'web-timestamp:0',
            'generic-start:0',
            'generic-end:0',
            'read-only:0',
            'suppress:0',
            'anchor-cancel:0',
        ]);
    });

    it('routes web plans through the late web lifecycle appliers without native callbacks', () => {
        const log: string[] = [];
        const webLifecycleEffect: TranscriptLifecycleHostScrollObservationPlan['lifecycleEffects'][number] = {
            sessionId: 'session-a',
            timestampMs: 1400,
            type: 'web-user-scroll-record-intent-timestamp',
        };

        const consumed = applyTranscriptLifecycleScrollObservationPlan(
            scrollObservationPlan({
                lifecycleEffects: [webLifecycleEffect],
                recentUserIntent: true,
            }),
            effectsRecorder(log),
        );

        expect(consumed).toBe(false);
        expect(log).toEqual([
            'continue:true:false',
            'commit:following',
            'web-takeover:1',
            'web-timestamp:1',
            'generic-start:0',
            'generic-end:0',
            'read-only:0',
            'suppress:0',
            'anchor-cancel:0',
        ]);
    });

    it('observes accepted paint before settled-return drain and before generic viewport state', () => {
        const log: string[] = [];

        const consumed = applyTranscriptLifecycleScrollObservationPlan(
            scrollObservationPlan({
                acceptedViewportPaintEffects: [acceptedPaintEffect],
                genericEffects: [genericViewportEffect],
                nativeSettledReturnEffects: {
                    drainEffects: [{
                        distanceFromLiveTailPx: 0,
                        isPinned: true,
                        sessionId: 'session-a',
                        type: 'drain-native-settled-return-to-live-tail',
                    }],
                    returnEffects: [{
                        distanceFromLiveTailPx: 0,
                        sessionId: 'session-a',
                        type: 'adopt-native-settled-return-to-live-tail',
                    }],
                },
            }),
            effectsRecorder(log),
        );

        expect(consumed).toBe(true);
        expect(log).toEqual([
            'continue:false:false',
            'commit:following',
            'web-takeover:0',
            'web-timestamp:0',
            'accepted-paint:1',
            'settled-return:1',
            'settled-drain:1',
            'generic-start:1',
            'accepted-paint:1',
            'generic-end:1',
            'read-only:1',
            'suppress:1',
            'anchor-cancel:1',
        ]);
    });
});
