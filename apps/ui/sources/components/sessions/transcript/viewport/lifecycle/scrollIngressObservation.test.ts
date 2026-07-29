import { describe, expect, it, vi } from 'vitest';

import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import { createTranscriptLifecycleHost } from './lifecycleHost';
import {
    observeTranscriptScrollIngress,
    type TranscriptScrollIngressCallbacks,
    type TranscriptScrollIngressInput,
} from './scrollIngressObservation';

function webMetrics(params: Readonly<{
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
}>): WebTranscriptScrollMetrics {
    return {
        clientHeight: params.clientHeight,
        element: {} as HTMLElement,
        scrollHeight: params.scrollHeight,
        scrollTop: params.scrollTop,
    };
}

function webScrollIngressInput(
    overrides: Partial<TranscriptScrollIngressInput> = {},
): TranscriptScrollIngressInput {
    return {
        bottomFollowModeState: {
            dragSession: null,
            mode: 'released',
        },
        configuredBottomDistanceNoiseFloorPx: 0,
        eventNativeEvent: {
            contentOffset: { y: 0 },
            contentSize: { height: 0 },
            isTrusted: true,
            layoutMeasurement: { height: 0 },
        },
        hasNativeContentMeasurement: false,
        hasNativeInitialViewportApplied: false,
        hasRenderedItems: true,
        isLoaded: true,
        isWarmKeepAliveInstance: false,
        lastScrollOffsetForIntent: 20,
        lastUserScrollIntentAtMs: 0,
        loadOlderInFlight: false,
        measuredContentHeight: 1200,
        measuredLayoutHeight: 400,
        nativeListDragActive: false,
        nativeMomentumScrollActive: false,
        nativeMountSettleDeadlineReached: false,
        nativeMountSettleStable: true,
        nowMs: 1300,
        pinEnabled: true,
        pinThresholdPx: 72,
        platform: 'web',
        sessionEntry: {
            sessionId: 'session-a',
            shouldFollowBottom: false,
        },
        sessionId: 'session-a',
        userIntentRecentMs: 500,
        wantsPinned: false,
        webMovementFact: {
            atEndPublicationCause: 'layout',
            direction: null,
            downwardIntent: false,
            isGenuineUserMovement: false,
            movedSinceLastObservation: false,
            upwardIntent: false,
        },
        ...overrides,
    };
}

function scrollIngressCallbacks(
    overrides: Partial<TranscriptScrollIngressCallbacks> = {},
): TranscriptScrollIngressCallbacks {
    const lifecycleHost = createTranscriptLifecycleHost();
    lifecycleHost.enterSession({
        platform: 'web',
        sessionId: 'session-a',
        shouldFollowLiveTail: false,
    });

    return {
        activeViewportCommandOwner: () => 'follow',
        applyEntryRestoreOwnerEffects: () => {},
        applyNativePrependOwnerEffects: () => {},
        applyScrollObservationPlan(plan, callbacks) {
            callbacks.continueAfterEarlyEffects({
                hasNativeMountSettlePassiveDriftRepinObservation: false,
                recentUserIntent: plan.recentUserIntent,
            });
            return plan.disposition === 'consumed';
        },
        commitOpenNativeEntryRestoreVisibleState: () => {},
        drainDeferredNewerMessages: () => {},
        hasOpenNativeEntryRestoreTransaction: () => false,
        hasOpenNativePrependTransaction: () => false,
        invalidateViewportAnchorCapture: () => {},
        lifecycleHost,
        observeMountSettleMetrics: () => {},
        observeNativeConfirmation: () => false,
        observeNativeEntryRestoreHostFacts: () => [],
        observeNativeBlankRecovery: () => {},
        observeNativePrependOwner: () => {},
        observeOlderPaginationScroll: () => {},
        observeTranscriptNavigationVisibility: () => {},
        preemptEntryRestoreTransaction: () => {},
        promotePendingJumpSeqViewportSnapshot: () => false,
        recordNativeScrollObservation: () => {},
        recordNativeVisibleWindowTelemetry: () => {},
        recordWebRouteJumpProtectionClearingMovement: () => {},
        resolveWebScrollMetrics: () => null,
        shouldIgnoreNativeInvalidScrollObservation: () => false,
        trustedNativePrependScroll: () => [],
        updateNativeViewportPaintObserved: () => {},
        verifyWebEntryRestoreTransaction: () => {},
        ...overrides,
    };
}

describe('observeTranscriptScrollIngress', () => {
    it('still observes exact-top pagination when jump promotion consumes generic viewport publication', () => {
        const observeOlderPaginationScroll = vi.fn();
        const applyScrollObservationPlan = vi.fn(() => false);

        observeTranscriptScrollIngress(webScrollIngressInput(), scrollIngressCallbacks({
            applyScrollObservationPlan,
            observeOlderPaginationScroll,
            promotePendingJumpSeqViewportSnapshot: () => true,
            resolveWebScrollMetrics: () => webMetrics({
                clientHeight: 500,
                scrollHeight: 2000,
                scrollTop: 0,
            }),
        }));

        expect(observeOlderPaginationScroll).toHaveBeenCalledOnce();
        expect(observeOlderPaginationScroll).toHaveBeenCalledWith({
            contentHeight: 1200,
            distanceFromBottom: 1500,
            layoutHeight: 400,
            offsetY: 0,
            trigger: 'edge-reached',
            webMetrics: expect.objectContaining({
                clientHeight: 500,
                scrollHeight: 2000,
                scrollTop: 0,
            }),
        });
        expect(applyScrollObservationPlan).not.toHaveBeenCalled();
    });

    it('consumes the renderer movement fact without independently reclassifying the same Legend event', () => {
        const lifecycleHost = createTranscriptLifecycleHost();
        lifecycleHost.enterSession({
            platform: 'web',
            sessionId: 'session-a',
            shouldFollowLiveTail: false,
        });
        const preemptEntryRestoreTransaction = vi.fn();
        const recordWebRouteJumpProtectionClearingMovement = vi.fn();
        const verifyWebEntryRestoreTransaction = vi.fn();

        observeTranscriptScrollIngress(webScrollIngressInput({
            lastScrollOffsetForIntent: 400,
            webMovementFact: {
                atEndPublicationCause: 'layout',
                direction: 1,
                downwardIntent: false,
                isGenuineUserMovement: false,
                movedSinceLastObservation: true,
                upwardIntent: false,
            },
        }), scrollIngressCallbacks({
            lifecycleHost,
            preemptEntryRestoreTransaction,
            recordWebRouteJumpProtectionClearingMovement,
            resolveWebScrollMetrics: () => webMetrics({
                clientHeight: 400,
                scrollHeight: 1200,
                scrollTop: 800,
            }),
            verifyWebEntryRestoreTransaction,
        }));

        expect(preemptEntryRestoreTransaction).not.toHaveBeenCalled();
        expect(recordWebRouteJumpProtectionClearingMovement).not.toHaveBeenCalled();
        expect(verifyWebEntryRestoreTransaction).toHaveBeenCalledOnce();
        expect(lifecycleHost.getState().bottomFollowState.mode).toBe('released');
    });

    it('routes invalid native offsets to blank recovery outside telemetry recording', () => {
        const log: string[] = [];

        observeTranscriptScrollIngress(webScrollIngressInput({
            eventNativeEvent: {
                contentOffset: { y: -995_030 },
                contentSize: { height: 2_000 },
                layoutMeasurement: { height: 500 },
            },
            platform: 'native',
        }), scrollIngressCallbacks({
            observeNativeBlankRecovery(reason, input) {
                log.push(`blank:${reason}:${input.rawOffsetY}`);
            },
            recordNativeScrollObservation(input) {
                log.push(`scroll:${input.reason}:${input.rawOffsetY}`);
            },
            recordNativeVisibleWindowTelemetry(reason) {
                log.push(`telemetry:${reason}`);
            },
            shouldIgnoreNativeInvalidScrollObservation: () => true,
        }));

        expect(log).toEqual([
            'scroll:invalid-native-offset:-995030',
            'blank:invalid-native-offset:-995030',
            'telemetry:invalid-native-offset',
        ]);
    });

    it('fails closed before lifecycle effects when a web renderer omits its movement fact', () => {
        const applyScrollObservationPlan = vi.fn(() => false);
        const observeTranscriptNavigationVisibility = vi.fn();
        const preemptEntryRestoreTransaction = vi.fn();
        const verifyWebEntryRestoreTransaction = vi.fn();

        const result = observeTranscriptScrollIngress(webScrollIngressInput({
            webMovementFact: undefined,
        }), scrollIngressCallbacks({
            applyScrollObservationPlan,
            observeTranscriptNavigationVisibility,
            preemptEntryRestoreTransaction,
            resolveWebScrollMetrics: () => webMetrics({
                clientHeight: 400,
                scrollHeight: 1200,
                scrollTop: 800,
            }),
            verifyWebEntryRestoreTransaction,
        }));

        expect(result.consumed).toBe(true);
        expect(result.observation?.platform).toBe('web');
        expect(observeTranscriptNavigationVisibility).not.toHaveBeenCalled();
        expect(preemptEntryRestoreTransaction).not.toHaveBeenCalled();
        expect(verifyWebEntryRestoreTransaction).not.toHaveBeenCalled();
        expect(applyScrollObservationPlan).not.toHaveBeenCalled();
    });

    it('publishes navigation visibility with the renderer web movement classification', () => {
        const observeTranscriptNavigationVisibility = vi.fn();

        observeTranscriptScrollIngress(webScrollIngressInput({
            webMovementFact: {
                atEndPublicationCause: 'user',
                direction: -1,
                downwardIntent: false,
                isGenuineUserMovement: true,
                movedSinceLastObservation: true,
                upwardIntent: true,
            },
        }), scrollIngressCallbacks({
            observeTranscriptNavigationVisibility,
            resolveWebScrollMetrics: () => webMetrics({
                clientHeight: 400,
                scrollHeight: 1200,
                scrollTop: 600,
            }),
        }));

        expect(observeTranscriptNavigationVisibility).toHaveBeenCalledWith({ genuineUserMovement: true });
    });

    // React Native puts `isTrusted` on the WEB synthetic event wrapper only; a
    // native scroll payload never carries it, so deriving the release signal from
    // it would answer `false` forever and a native jump landing would pin the rail
    // to the landed turn for the rest of the session. The app-owned open-drag fact
    // is the native user-authority signal.
    it('derives the native release signal from the open drag, not from event trust', () => {
        const withoutDrag = vi.fn();
        observeTranscriptScrollIngress(webScrollIngressInput({
            eventNativeEvent: {
                contentOffset: { y: 300 },
                contentSize: { height: 1200 },
                layoutMeasurement: { height: 400 },
            },
            nativeListDragActive: false,
            platform: 'native',
            webMovementFact: undefined,
        }), scrollIngressCallbacks({ observeTranscriptNavigationVisibility: withoutDrag }));
        expect(withoutDrag).toHaveBeenCalledWith({ genuineUserMovement: false });

        const withDrag = vi.fn();
        observeTranscriptScrollIngress(webScrollIngressInput({
            eventNativeEvent: {
                contentOffset: { y: 300 },
                contentSize: { height: 1200 },
                layoutMeasurement: { height: 400 },
            },
            nativeListDragActive: true,
            platform: 'native',
            webMovementFact: undefined,
        }), scrollIngressCallbacks({ observeTranscriptNavigationVisibility: withDrag }));
        expect(withDrag).toHaveBeenCalledWith({ genuineUserMovement: true });
    });
});
