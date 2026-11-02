import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import { recordFirstListPaintTelemetry, recordStablePaintTelemetry } from './paintTelemetry';
import { useTranscriptTelemetryHost, type TranscriptPaintTelemetryState } from './useTranscriptTelemetryHost';

/**
 * First paint cannot happen after stable paint.
 *
 * Measured on device 2026-08-18: one session open reported
 * `openToFirstPaint` 2044ms and `openToStablePaint` 1410ms. Both are measured from the
 * same origin, so that ordering is impossible — and it matters, because
 * `openToFirstPaint` is the number every other open-latency fix is judged by.
 *
 * The cause is that the two marks have different triggers. First paint is recorded ONLY
 * when a native viewport paint is accepted; stable paint is additionally reachable via
 * mount settle and via the deadline. When the transcript settles without an accepted
 * viewport paint, stable records and first paint either never records or records later
 * off some unrelated observation.
 *
 * A transcript cannot be stable without having painted, so stable paint is a truthful
 * UPPER bound on first paint. Recording it there keeps the pair ordered and never
 * invents a paint that did not occur. Whether a real list paint was observed remains
 * legible on the stable record's own `firstListPaintObserved` field, so a derived first
 * paint is still distinguishable from an observed one.
 */

function paintState(sessionId: string, startedAtMs: number): TranscriptPaintTelemetryState {
    return { recorded: false, sessionId, startedAtMs };
}

function stableParams(overrides: Partial<Parameters<typeof recordStablePaintTelemetry>[0]> = {}) {
    return {
        clearWebStablePaintRetry: () => {},
        coldItemCount: 0,
        committedMessagesCount: 12,
        firstListPaintObserved: false,
        hotItemCount: 0,
        isWarmKeepAliveInstance: false,
        itemCount: 12,
        nativeMountSettleDeadlineReached: false,
        nativeMountSettleStable: true,
        nativeViewportObserved: false,
        paintMetrics: { contentHeight: 1000, distanceFromBottom: 0, layoutHeight: 800 },
        platformOS: 'ios',
        routeHydrationPending: false,
        sessionId: 'session-1',
        telemetryState: paintState('session-1', 0),
        webHotColdSplit: false,
        ...overrides,
    } as Parameters<typeof recordStablePaintTelemetry>[0];
}

function readDurations(name: string): number {
    const snapshot = syncPerformanceTelemetry.snapshot();
    const event = snapshot.events.find((candidate) => candidate.name === name);
    return event ? event.count : 0;
}

describe('transcript paint telemetry ordering', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        syncPerformanceTelemetry.configure({ enabled: true, flushIntervalMs: 30_000 });
        syncPerformanceTelemetry.reset();
    });

    afterEach(() => {
        syncPerformanceTelemetry.reset();
        syncPerformanceTelemetry.configure({ enabled: false });
        vi.useRealTimers();
    });

    it('records the first paint it never observed when the transcript settles without one', () => {
        const firstPaintState = paintState('session-1', 0);

        recordStablePaintTelemetry(stableParams({ firstPaintTelemetryState: firstPaintState }));

        // Stable paint happened, so a first paint necessarily did too.
        expect(readDurations('ui.sessions.transcript.stablePaint')).toBe(1);
        expect(readDurations('ui.sessions.transcript.firstPaint')).toBe(1);
        expect(firstPaintState.recorded).toBe(true);
    });

    it('leaves an already-observed first paint alone, so a real observation is never overwritten', () => {
        const firstPaintState = paintState('session-1', 0);
        recordFirstListPaintTelemetry({
            committedMessagesCount: 12,
            itemCount: 12,
            platformOS: 'ios',
            routeHydrationPending: false,
            sessionId: 'session-1',
            telemetryState: firstPaintState,
        });
        expect(readDurations('ui.sessions.transcript.firstPaint')).toBe(1);

        recordStablePaintTelemetry(stableParams({ firstPaintTelemetryState: firstPaintState }));

        // Still exactly one first paint: the observed one.
        expect(readDurations('ui.sessions.transcript.firstPaint')).toBe(1);
        expect(readDurations('ui.sessions.transcript.stablePaint')).toBe(1);
    });

    it.each(['disabled', 'recorded'] as const)('stops web paint retries when telemetry is %s', async (state) => {
        const screen = await renderHook(() => useTranscriptTelemetryHost({ platformOS: 'web', sessionId: 'session-1' }));
        try {
            // Prove this mounted owner can retry before testing its stopping condition.
            screen.getCurrent().scheduleWebStablePaintRetry();
            await flushHookEffects({ advanceTimersMs: 80, cycles: 1 });
            expect(screen.getCurrent().webStablePaintRetryTick).toBe(1);

            if (state === 'disabled') {
                syncPerformanceTelemetry.configure({ enabled: false });
            } else {
                const host = screen.getCurrent();
                expect(recordStablePaintTelemetry(stableParams({
                    platformOS: 'web',
                    telemetryState: host.stablePaintTelemetryRef.current,
                    clearWebStablePaintRetry: host.clearWebStablePaintRetry,
                }))).toBe(true);
            }

            screen.getCurrent().scheduleWebStablePaintRetry();
            await flushHookEffects({ advanceTimersMs: 80, cycles: 1 });
            expect(screen.getCurrent().webStablePaintRetryTick).toBe(1);
        } finally {
            await screen.unmount();
        }
    });
});
