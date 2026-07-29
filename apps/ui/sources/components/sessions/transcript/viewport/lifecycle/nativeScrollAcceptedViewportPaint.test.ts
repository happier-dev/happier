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

    // Contract change (2026-07-28, ported from remote-dev W7/A-fix). This case previously asserted
    // that reaching the live-tail threshold is sufficient to release the first accepted paint. That
    // makes the reveal edge unconditional on every native open: the transcript paints wherever the
    // list currently is and then moves once native placement settles, which is the cold-open
    // flicker. The reveal edge on native is settle-stable, the mount-settle deadline, or the warm
    // keep-alive allowance — never an unconditional accept.
    it('holds follow-bottom paint release at the live tail before mount settle or deadline', () => {
        expect(resolveNativeFollowBottomObservationCanReleasePaint({
            ...baseFollowBottomObservation,
            distanceFromLiveTailPx: 72,
        })).toBe(false);
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

    it('allows native paint release only after mount-settle stability or deadline', () => {
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

    // Blank-screen guard. A settle signal that never stabilizes must not withhold the reveal: the
    // deadline is the second, independent release edge, and its producer
    // (`useTranscriptNativeMountSettleLifecycle`) always reaches it within
    // `transcriptInitialFillBudgetMs + transcriptMountSettleQuiescentWindowMs`. This gate may delay
    // a reveal; it must never be able to hang one.
    it('releases paint on the mount-settle deadline when stability never arrives', () => {
        expect(resolveNativeFollowBottomObservationCanReleasePaint({
            ...baseFollowBottomObservation,
            isWarmKeepAliveInstance: false,
            nativeMountSettleDeadlineReached: true,
            nativeMountSettleStable: false,
            sessionEntryShouldFollowBottom: false,
        })).toBe(true);
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

    it('creates accepted paint observation effects once mount settle is stable', () => {
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
            nativeMountSettleStable: true,
            sessionEntryShouldFollowBottom: undefined,
            sessionId: 'session-a',
            thresholdPx: 72,
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

    // The whole point of the port: the same observation with no settle fact is NOT a reveal.
    it('creates no accepted paint observation effects at the live tail before mount settle', () => {
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
            sessionEntryShouldFollowBottom: undefined,
            sessionId: 'session-a',
            thresholdPx: 72,
            wantsPinned: true,
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
            sessionEntryShouldFollowBottom: undefined,
            sessionId: 'session-a',
            thresholdPx: 72,
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
            sessionEntryShouldFollowBottom: undefined,
            sessionId: 'session-a',
            thresholdPx: 72,
            wantsPinned: false,
        })).toHaveLength(1);
    });
});
