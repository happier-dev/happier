import { describe, expect, it } from 'vitest';

import { createTranscriptMountSettlePinCoordinator } from './mountSettle';

/**
 * When the next settle check is actually worth running.
 *
 * Settle is "no meaningful geometry change for `quiescentWindowMs`", and it can only be
 * DETECTED when something calls `sample`. Two things sample: the scroll-ingress path,
 * which is event-driven and already samples on every real geometry observation, and a
 * fixed repeating interval in the native mount-settle lifecycle.
 *
 * The interval ticks on its own phase, unrelated to when geometry last moved, so
 * detection lands at the first tick at or after `lastChange + quiescentWindowMs` — up to
 * a full window late, and it keeps waking the thread while geometry is still churning.
 *
 * This exposes the one fact the caller needs to schedule itself exactly: how long until
 * quiescence could next be declared. It makes the timer follow the events instead of a
 * phase, and it is the same number the coordinator already compares against internally —
 * so the schedule and the decision cannot drift apart.
 */

const TUNING = { bottomDistanceNoiseFloorPx: 0, dimensionNoiseFloorPx: 0, quiescentWindowMs: 120 };

function readyCoordinator(startMs: number) {
    const coordinator = createTranscriptMountSettlePinCoordinator({ tuning: TUNING });
    coordinator.recordFirstListPaint({ sessionId: 's1', nowMs: startMs });
    coordinator.recordLayoutCommitObserved({ sessionId: 's1', nowMs: startMs });
    coordinator.observeMetrics({
        sessionId: 's1',
        nowMs: startMs,
        initialFillStatus: 'done',
        listContentHeight: 1000,
        listLayoutHeight: 800,
        distanceFromBottom: 0,
        composerInsetHeight: 0,
    } as never);
    return coordinator;
}

describe('mount settle quiescence scheduling', () => {
    it('asks to be woken exactly when quiescence completes, not on a fixed phase', () => {
        const coordinator = readyCoordinator(1_000);
        // Geometry last moved at 1_000, so quiescence completes at 1_120.
        expect(coordinator.nextSettleCheckDelayMs(1_000)).toBe(120);
        expect(coordinator.nextSettleCheckDelayMs(1_060)).toBe(60);
        expect(coordinator.nextSettleCheckDelayMs(1_119)).toBe(1);
    });

    it('reports no remaining wait once the window has already elapsed', () => {
        const coordinator = readyCoordinator(1_000);
        expect(coordinator.nextSettleCheckDelayMs(1_200)).toBe(0);
    });

    it('re-arms from the LAST change, so churn extends the wait instead of settling early', () => {
        const coordinator = readyCoordinator(1_000);
        // A real geometry move at 1_100 pushes quiescence out to 1_220.
        coordinator.observeMetrics({
            sessionId: 's1',
            nowMs: 1_100,
            initialFillStatus: 'done',
            listContentHeight: 1_400,
            listLayoutHeight: 800,
            distanceFromBottom: 0,
            composerInsetHeight: 0,
        } as never);
        expect(coordinator.nextSettleCheckDelayMs(1_100)).toBe(120);
    });

    it('stops asking to be woken once settled', () => {
        const coordinator = readyCoordinator(1_000);
        coordinator.sample({ sessionId: 's1', nowMs: 1_200 });
        expect(coordinator.getSnapshot().stableSettle).toBe(true);
        expect(coordinator.nextSettleCheckDelayMs(1_200)).toBeNull();
    });
});
