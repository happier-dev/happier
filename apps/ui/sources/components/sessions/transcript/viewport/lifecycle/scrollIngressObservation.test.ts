import { describe, expect, it } from 'vitest';

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
        lastNativePinOffset: null,
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
        pendingBottomPin: false,
        pinEnabled: true,
        pinThresholdPx: 72,
        platform: 'web',
        sessionEntry: {
            sessionId: 'session-a',
            shouldFollowBottom: false,
        },
        sessionId: 'session-a',
        userIntentRecentMs: 500,
        usesNativeFlashListBottomMaintenance: false,
        wantsPinned: false,
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
        applyNativeMountSettlePassiveDriftRepinObservation: () => {},
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
        observeWebGenuineScrollMovement: () => ({
            webMovedSinceLastObservation: true,
            webObservedUpwardIntent: true,
            webObservedUserScrollMovement: true,
        }),
        observeWebTranscriptNavigationVisibility: () => {},
        preemptEntryRestoreTransaction: () => {},
        promotePendingJumpSeqViewportSnapshot: () => false,
        recordNativeScrollObservation: () => {},
        recordNativeVisibleWindowTelemetry: () => {},
        recordWebRouteJumpProtectionClearingMovement: () => {},
        refreshInFlightWebPrependAnchor: () => {},
        resolveWebScrollMetrics: () => null,
        retargetPendingWebPrependAnchorForUserScroll: () => {},
        shouldIgnoreNativeInvalidScrollObservation: () => false,
        trustedNativePrependScroll: () => [],
        updateNativeViewportPaintObserved: () => {},
        verifyWebEntryRestoreTransaction: () => {},
        ...overrides,
    };
}

describe('observeTranscriptScrollIngress', () => {
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

    it('refreshes the web prepend anchor when older pagination starts during a discrete scroll observation', () => {
        const log: string[] = [];
        let loadOlderInFlight = false;

        observeTranscriptScrollIngress(webScrollIngressInput(), scrollIngressCallbacks({
            observeOlderPaginationScroll(input) {
                log.push(`older:${input.trigger}`);
                loadOlderInFlight = true;
                return loadOlderInFlight;
            },
            refreshInFlightWebPrependAnchor(input) {
                log.push(`refresh:${input.userScrolledDuringLoad}`);
            },
            resolveWebScrollMetrics: () => webMetrics({
                clientHeight: 500,
                scrollHeight: 2000,
                scrollTop: 0,
            }),
        }));

        expect(log).toEqual([
            'older:edge-reached',
            'refresh:true',
        ]);
    });
});
