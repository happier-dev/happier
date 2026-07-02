import { describe, expect, it } from 'vitest';

import { createTranscriptMountSettlePinCoordinator } from './transcriptMountSettlePinCoordinator';

const tuning = {
    quiescentWindowMs: 100,
    dimensionNoiseFloorPx: 1,
    bottomDistanceNoiseFloorPx: 2,
} as const;

function observeDoneAt(nowMs: number) {
    return {
        sessionId: 'session-a',
        nowMs,
        initialFillStatus: 'done' as const,
        listContentHeight: 1200,
        listLayoutHeight: 640,
        composerInsetHeight: 220,
        distanceFromBottom: 0,
    };
}

describe('transcriptMountSettlePinCoordinator', () => {
    it('tracks first paint and layout commit separately from stable settle', () => {
        const coordinator = createTranscriptMountSettlePinCoordinator({ tuning });

        coordinator.recordFirstListPaint({ sessionId: 'session-a', nowMs: 0 });
        expect(coordinator.getSnapshot()).toMatchObject({
            firstListPaint: true,
            layoutCommitObserved: false,
            stableSettle: false,
        });

        coordinator.recordLayoutCommitObserved({ sessionId: 'session-a', nowMs: 10 });
        expect(coordinator.getSnapshot()).toMatchObject({
            firstListPaint: true,
            layoutCommitObserved: true,
            stableSettle: false,
        });
    });

    it('waits for initial fill, non-zero dimensions, composer quiescence, and a bounded sample before stable settle', () => {
        const coordinator = createTranscriptMountSettlePinCoordinator({ tuning });
        coordinator.recordFirstListPaint({ sessionId: 'session-a', nowMs: 0 });
        coordinator.recordLayoutCommitObserved({ sessionId: 'session-a', nowMs: 10 });

        coordinator.observeMetrics({
            ...observeDoneAt(20),
            listContentHeight: 0,
        });
        coordinator.sample({ sessionId: 'session-a', nowMs: 200 });
        expect(coordinator.getSnapshot().stableSettle).toBe(false);

        coordinator.observeMetrics({
            ...observeDoneAt(210),
            composerInsetHeight: 240,
        });
        coordinator.sample({ sessionId: 'session-a', nowMs: 309 });
        expect(coordinator.getSnapshot().stableSettle).toBe(false);

        coordinator.sample({ sessionId: 'session-a', nowMs: 310 });
        expect(coordinator.getSnapshot().stableSettle).toBe(true);
    });

    it('does not settle on the same metrics sample that reports a meaningful late layout change', () => {
        const coordinator = createTranscriptMountSettlePinCoordinator({ tuning });
        coordinator.recordFirstListPaint({ sessionId: 'session-a', nowMs: 0 });
        coordinator.recordLayoutCommitObserved({ sessionId: 'session-a', nowMs: 0 });
        coordinator.observeMetrics(observeDoneAt(20));

        coordinator.observeMetrics({
            ...observeDoneAt(140),
            listContentHeight: 1600,
        });

        expect(coordinator.getSnapshot().stableSettle).toBe(false);

        coordinator.observeMetrics({
            ...observeDoneAt(239),
            listContentHeight: 1600,
        });
        expect(coordinator.getSnapshot().stableSettle).toBe(false);

        coordinator.observeMetrics({
            ...observeDoneAt(240),
            listContentHeight: 1600,
        });
        expect(coordinator.getSnapshot().stableSettle).toBe(true);
    });
});
