import { describe, expect, it } from 'vitest';

import {
    resolveNativeFollowBottomObservationCanReleasePaint,
    resolveNativeScrollAcceptedViewportPaintObservationEffects,
    resolveNativeScrollAcceptedViewportPaintDecision,
    resolveNativeScrollAcceptedViewportPaintEffects,
} from './nativeScrollAcceptedViewportPaint';

describe('native scroll accepted viewport paint decision', () => {
    const baseFollowBottomObservation = {
        distanceFromLiveTailPx: 0,
        isWarmKeepAliveInstance: false,
        nativeMountSettleDeadlineReached: false,
        nativeMountSettleStable: false,
        sessionEntryShouldFollowBottom: undefined,
        thresholdPx: 72,
        usesNativeFlashListBottomMaintenance: true,
    } as const;

    const baseNativeObservation = {
        entryRestoreConfirmedByObservation: false,
        hasRenderedItems: true,
        isLoaded: true,
        isNative: true,
        isTrusted: false,
        nativeFollowBottomObservationCanReleasePaint: false,
        refDistanceFromLiveTailPx: 0,
        thresholdPx: 72,
        wantsPinned: true,
    } as const;

    it('allows follow-bottom paint release when native bottom maintenance is not used', () => {
        expect(resolveNativeFollowBottomObservationCanReleasePaint({
            ...baseFollowBottomObservation,
            distanceFromLiveTailPx: 72,
            usesNativeFlashListBottomMaintenance: false,
        })).toBe(true);
    });

    it('blocks follow-bottom paint release when the observation is beyond the threshold', () => {
        const beyondThresholdObservation = {
            ...baseFollowBottomObservation,
            distanceFromLiveTailPx: 73,
        };

        expect(resolveNativeFollowBottomObservationCanReleasePaint({
            ...beyondThresholdObservation,
            nativeMountSettleStable: true,
        })).toBe(false);
        expect(resolveNativeFollowBottomObservationCanReleasePaint({
            ...beyondThresholdObservation,
            nativeMountSettleDeadlineReached: true,
        })).toBe(false);
        expect(resolveNativeFollowBottomObservationCanReleasePaint({
            ...beyondThresholdObservation,
            isWarmKeepAliveInstance: true,
        })).toBe(false);
    });

    it('allows native bottom-maintained paint release only after mount-settle stability or deadline', () => {
        expect(resolveNativeFollowBottomObservationCanReleasePaint({
            ...baseFollowBottomObservation,
            nativeMountSettleStable: true,
        })).toBe(true);
        expect(resolveNativeFollowBottomObservationCanReleasePaint({
            ...baseFollowBottomObservation,
            nativeMountSettleDeadlineReached: true,
        })).toBe(true);
        expect(resolveNativeFollowBottomObservationCanReleasePaint(baseFollowBottomObservation)).toBe(false);
    });

    it('preserves the warm keep-alive follow-bottom bypass', () => {
        expect(resolveNativeFollowBottomObservationCanReleasePaint({
            ...baseFollowBottomObservation,
            isWarmKeepAliveInstance: true,
            sessionEntryShouldFollowBottom: true,
        })).toBe(true);
        expect(resolveNativeFollowBottomObservationCanReleasePaint({
            ...baseFollowBottomObservation,
            isWarmKeepAliveInstance: true,
            sessionEntryShouldFollowBottom: undefined,
        })).toBe(true);
        expect(resolveNativeFollowBottomObservationCanReleasePaint({
            ...baseFollowBottomObservation,
            isWarmKeepAliveInstance: true,
            sessionEntryShouldFollowBottom: false,
        })).toBe(false);
    });

    it('records accepted native untrusted observations from follow-bottom paint release', () => {
        expect(resolveNativeScrollAcceptedViewportPaintDecision({
            ...baseNativeObservation,
            nativeFollowBottomObservationCanReleasePaint: true,
        })).toEqual({ type: 'record-accepted-viewport-paint' });
    });

    it('records accepted native untrusted observations from entry-restore confirmation', () => {
        expect(resolveNativeScrollAcceptedViewportPaintDecision({
            ...baseNativeObservation,
            entryRestoreConfirmedByObservation: true,
        })).toEqual({ type: 'record-accepted-viewport-paint' });
    });

    it('records accepted native untrusted observations after an unpinned reader is beyond the threshold', () => {
        expect(resolveNativeScrollAcceptedViewportPaintDecision({
            ...baseNativeObservation,
            refDistanceFromLiveTailPx: 91,
            wantsPinned: false,
        })).toEqual({ type: 'record-accepted-viewport-paint' });
    });

    it('skips observations before acceptance checks when the platform or observation is not eligible', () => {
        expect(resolveNativeScrollAcceptedViewportPaintDecision({
            ...baseNativeObservation,
            isNative: false,
            nativeFollowBottomObservationCanReleasePaint: true,
        })).toEqual({
            reason: 'not-native',
            type: 'skip',
        });

        expect(resolveNativeScrollAcceptedViewportPaintDecision({
            ...baseNativeObservation,
            isLoaded: false,
            nativeFollowBottomObservationCanReleasePaint: true,
        })).toEqual({
            reason: 'not-loaded',
            type: 'skip',
        });

        expect(resolveNativeScrollAcceptedViewportPaintDecision({
            ...baseNativeObservation,
            hasRenderedItems: false,
            nativeFollowBottomObservationCanReleasePaint: true,
        })).toEqual({
            reason: 'empty-list',
            type: 'skip',
        });

        expect(resolveNativeScrollAcceptedViewportPaintDecision({
            ...baseNativeObservation,
            isTrusted: true,
            nativeFollowBottomObservationCanReleasePaint: true,
        })).toEqual({
            reason: 'trusted-observation',
            type: 'skip',
        });

        expect(resolveNativeScrollAcceptedViewportPaintDecision(baseNativeObservation)).toEqual({
            reason: 'not-accepted',
            type: 'skip',
        });
    });

    it('creates a record effect with normalized fallback metrics for accepted paint observations', () => {
        expect(resolveNativeScrollAcceptedViewportPaintEffects({
            decision: { type: 'record-accepted-viewport-paint' },
            fallbackMetrics: {
                contentHeight: 42.8,
                distanceFromLiveTailPx: -3.4,
                layoutHeight: 17.9,
            },
            sessionId: 'session-a',
        })).toEqual([{
            fallbackMetrics: {
                contentHeight: 42,
                distanceFromLiveTailPx: 0,
                layoutHeight: 17,
            },
            sessionId: 'session-a',
            type: 'record-accepted-viewport-paint',
        }]);
    });

    it('creates no effects for skipped paint observations', () => {
        expect(resolveNativeScrollAcceptedViewportPaintEffects({
            decision: {
                reason: 'not-accepted',
                type: 'skip',
            },
            fallbackMetrics: {
                contentHeight: 42.8,
                distanceFromLiveTailPx: 91.2,
                layoutHeight: 17.9,
            },
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('creates accepted paint observation effects from follow-bottom readiness', () => {
        expect(resolveNativeScrollAcceptedViewportPaintObservationEffects({
            distanceFromLiveTailPx: 72,
            entryRestoreConfirmedByObservation: false,
            fallbackMetrics: {
                contentHeight: 42.8,
                distanceFromLiveTailPx: -3.4,
                layoutHeight: 17.9,
            },
            hasRenderedItems: true,
            isLoaded: true,
            isNative: true,
            isTrusted: false,
            isWarmKeepAliveInstance: false,
            nativeMountSettleDeadlineReached: false,
            nativeMountSettleStable: false,
            sessionId: 'session-a',
            sessionEntryShouldFollowBottom: undefined,
            thresholdPx: 72,
            usesNativeFlashListBottomMaintenance: false,
            wantsPinned: true,
        })).toEqual([{
            fallbackMetrics: {
                contentHeight: 42,
                distanceFromLiveTailPx: 0,
                layoutHeight: 17,
            },
            sessionId: 'session-a',
            type: 'record-accepted-viewport-paint',
        }]);
    });

    it('preserves native bottom-maintained readiness gates in observation effects', () => {
        const baseObservation = {
            distanceFromLiveTailPx: 0,
            entryRestoreConfirmedByObservation: false,
            fallbackMetrics: {
                contentHeight: 42,
                distanceFromLiveTailPx: 0,
                layoutHeight: 17,
            },
            hasRenderedItems: true,
            isLoaded: true,
            isNative: true,
            isTrusted: false,
            isWarmKeepAliveInstance: false,
            nativeMountSettleDeadlineReached: false,
            nativeMountSettleStable: false,
            sessionId: 'session-a',
            sessionEntryShouldFollowBottom: undefined,
            thresholdPx: 72,
            usesNativeFlashListBottomMaintenance: true,
            wantsPinned: true,
        } as const;

        expect(resolveNativeScrollAcceptedViewportPaintObservationEffects(baseObservation)).toEqual([]);
        expect(resolveNativeScrollAcceptedViewportPaintObservationEffects({
            ...baseObservation,
            nativeMountSettleStable: true,
        })).toHaveLength(1);
        expect(resolveNativeScrollAcceptedViewportPaintObservationEffects({
            ...baseObservation,
            nativeMountSettleDeadlineReached: true,
        })).toHaveLength(1);
        expect(resolveNativeScrollAcceptedViewportPaintObservationEffects({
            ...baseObservation,
            isWarmKeepAliveInstance: true,
            sessionEntryShouldFollowBottom: undefined,
        })).toHaveLength(1);
        expect(resolveNativeScrollAcceptedViewportPaintObservationEffects({
            ...baseObservation,
            isWarmKeepAliveInstance: true,
            sessionEntryShouldFollowBottom: false,
        })).toEqual([]);
    });

    it('accepts observation effects from entry-restore confirmation even when follow-bottom readiness is false', () => {
        expect(resolveNativeScrollAcceptedViewportPaintObservationEffects({
            distanceFromLiveTailPx: 0,
            entryRestoreConfirmedByObservation: true,
            fallbackMetrics: {
                contentHeight: 42,
                distanceFromLiveTailPx: 0,
                layoutHeight: 17,
            },
            hasRenderedItems: true,
            isLoaded: true,
            isNative: true,
            isTrusted: false,
            isWarmKeepAliveInstance: false,
            nativeMountSettleDeadlineReached: false,
            nativeMountSettleStable: false,
            sessionId: 'session-a',
            sessionEntryShouldFollowBottom: undefined,
            thresholdPx: 72,
            usesNativeFlashListBottomMaintenance: true,
            wantsPinned: true,
        })).toHaveLength(1);
    });

    it('accepts observation effects from unpinned distance beyond threshold', () => {
        expect(resolveNativeScrollAcceptedViewportPaintObservationEffects({
            distanceFromLiveTailPx: 91,
            entryRestoreConfirmedByObservation: false,
            fallbackMetrics: {
                contentHeight: 42,
                distanceFromLiveTailPx: 91,
                layoutHeight: 17,
            },
            hasRenderedItems: true,
            isLoaded: true,
            isNative: true,
            isTrusted: false,
            isWarmKeepAliveInstance: false,
            nativeMountSettleDeadlineReached: false,
            nativeMountSettleStable: false,
            sessionId: 'session-a',
            sessionEntryShouldFollowBottom: undefined,
            thresholdPx: 72,
            usesNativeFlashListBottomMaintenance: true,
            wantsPinned: false,
        })).toHaveLength(1);
    });
});
