import { afterEach, describe, expect, it } from 'vitest';

import { createSyncPerformanceTelemetry, syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import {
    createRealtimeFanoutTelemetryAccumulator,
    flushRealtimeFanoutTelemetry,
    recordRealtimeFanoutSocketMessageRoute,
    resetRealtimeFanoutTelemetry,
} from './realtimeFanoutTelemetry';

function createHarness() {
    let now = 0;
    const telemetry = createSyncPerformanceTelemetry({
        enabled: true,
        slowThresholdMs: 1_000_000,
        flushIntervalMs: 60_000,
        now: () => now,
    });
    const fanout = createRealtimeFanoutTelemetryAccumulator({
        telemetry,
        windowMs: 1_000,
        now: () => now,
    });
    return {
        telemetry,
        fanout,
        setNow: (nextNow: number) => {
            now = nextNow;
        },
    };
}

function findFanoutEvent(telemetry: ReturnType<typeof createSyncPerformanceTelemetry>) {
    return telemetry
        .snapshot()
        .events.find((event) => event.name === 'sync.sessions.realtime.fanout.window');
}

describe('realtime fanout telemetry', () => {
    afterEach(() => {
        resetRealtimeFanoutTelemetry();
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('flushes distinct socket sessions and route counts for a rolling window', () => {
        const { telemetry, fanout } = createHarness();

        fanout.recordSocketMessageRoute({
            sessionId: 's1',
            updateType: 'new-message',
            route: 'projectionOnly',
            visible: false,
            fullContentConsumerActive: false,
            messagesLoaded: false,
            messageSeq: 2,
        });
        fanout.recordSocketMessageRoute({
            sessionId: 's1',
            updateType: 'message-updated',
            route: 'markTranscriptStale',
            visible: false,
            fullContentConsumerActive: false,
            messagesLoaded: true,
            messageSeq: 3,
        });
        fanout.recordSocketMessageRoute({
            sessionId: 's2',
            updateType: 'new-message',
            route: 'fullTranscriptApply',
            visible: true,
            fullContentConsumerActive: true,
            messagesLoaded: true,
            messageSeq: null,
        });

        fanout.flush();

        expect(findFanoutEvent(telemetry)).toMatchObject({
            count: 1,
            fields: expect.objectContaining({
                windowMs: 1_000,
                routeDecisions: 3,
                socketMessagesPerSecond: 3,
                distinctSessions: 2,
                distinctSessionsPerSecond: 2,
                newMessages: 2,
                messageUpdates: 1,
                projectionOnly: 1,
                transcriptStale: 1,
                projectionPatches: 2,
                projectionPatchesPerSecond: 2,
                fullTranscriptApply: 1,
                fullTranscriptAppliesPerSecond: 1,
                visibleSessionMessages: 1,
                backgroundSessionMessages: 2,
                fullContentConsumerMessages: 1,
                messagesLoaded: 2,
                seqKnown: 2,
            }),
        });
    });

    it('keeps coalescer queue depth and batch activity in the same fanout window', () => {
        const { telemetry, fanout } = createHarness();

        fanout.recordCoalescerActivity({
            kind: 'enqueue',
            sessionId: 's1',
            messages: 2,
            queued: 2,
        });
        fanout.recordCoalescerActivity({
            kind: 'flush',
            sessionId: 's1',
            messages: 1,
            queued: 1,
        });
        fanout.recordCoalescerActivity({
            kind: 'drop',
            sessionId: 's2',
            messages: 3,
            queued: 0,
        });

        fanout.flush();

        expect(findFanoutEvent(telemetry)).toMatchObject({
            count: 1,
            fields: expect.objectContaining({
                coalescerEnqueues: 1,
                coalescerMessagesEnqueued: 2,
                coalescerFlushes: 1,
                coalescerMessagesFlushed: 1,
                coalescerDrops: 1,
                coalescerMessagesDropped: 3,
                maxCoalescerQueueDepth: 2,
            }),
        });
    });

    it('does not clear singleton windows when an unrelated telemetry instance resets', () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();
        resetRealtimeFanoutTelemetry();
        const auxiliaryTelemetry = createSyncPerformanceTelemetry({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });

        recordRealtimeFanoutSocketMessageRoute({
            sessionId: 's1',
            updateType: 'new-message',
            route: 'projectionOnly',
            visible: false,
            fullContentConsumerActive: false,
            messagesLoaded: false,
            messageSeq: 1,
        });

        auxiliaryTelemetry.reset();
        flushRealtimeFanoutTelemetry();

        expect(syncPerformanceTelemetry.snapshot().events).toContainEqual(expect.objectContaining({
            name: 'sync.sessions.realtime.fanout.window',
            fields: expect.objectContaining({ routeDecisions: 1 }),
        }));
    });

    it('clears pending singleton windows when sync telemetry resets directly', () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();
        resetRealtimeFanoutTelemetry();

        recordRealtimeFanoutSocketMessageRoute({
            sessionId: 's1',
            updateType: 'new-message',
            route: 'projectionOnly',
            visible: false,
            fullContentConsumerActive: false,
            messagesLoaded: false,
            messageSeq: 1,
        });

        syncPerformanceTelemetry.reset();
        flushRealtimeFanoutTelemetry();

        expect(syncPerformanceTelemetry.snapshot().events).toEqual([]);
    });

    it('does not over-extrapolate rates for manually flushed partial windows', () => {
        const { telemetry, fanout, setNow } = createHarness();

        fanout.recordSocketMessageRoute({
            sessionId: 's1',
            updateType: 'new-message',
            route: 'projectionOnly',
            visible: false,
            fullContentConsumerActive: false,
            messagesLoaded: false,
            messageSeq: 1,
        });

        setNow(100);
        fanout.flush();

        expect(findFanoutEvent(telemetry)).toMatchObject({
            fields: expect.objectContaining({
                windowMs: 100,
                routeDecisions: 1,
                socketMessagesPerSecond: 1,
                distinctSessionsPerSecond: 1,
                projectionPatchesPerSecond: 1,
            }),
        });
    });

    it('emits a completed window before recording the next window', () => {
        const { telemetry, fanout, setNow } = createHarness();

        fanout.recordSocketMessageRoute({
            sessionId: 's1',
            updateType: 'new-message',
            route: 'projectionOnly',
            visible: false,
            fullContentConsumerActive: false,
            messagesLoaded: false,
            messageSeq: 1,
        });

        setNow(1_050);
        fanout.recordSocketMessageRoute({
            sessionId: 's2',
            updateType: 'new-message',
            route: 'fullTranscriptApply',
            visible: true,
            fullContentConsumerActive: false,
            messagesLoaded: true,
            messageSeq: 2,
        });
        fanout.flush();

        const event = findFanoutEvent(telemetry);
        expect(event).toMatchObject({
            count: 2,
            fields: expect.objectContaining({
                routeDecisions: 2,
                distinctSessions: 2,
                projectionOnly: 1,
                fullTranscriptApply: 1,
            }),
            fieldStats: expect.objectContaining({
                routeDecisions: expect.objectContaining({ max: 1 }),
                distinctSessions: expect.objectContaining({ max: 1 }),
            }),
        });
        expect(event?.fieldStats.socketMessagesPerSecond?.min).toBeCloseTo(1000 / 1050, 6);
        expect(event?.fieldStats.projectionPatchesPerSecond?.max).toBeCloseTo(1000 / 1050, 6);
        expect(event?.fieldStats.fullTranscriptAppliesPerSecond?.max).toBe(1);
        expect(event?.fieldStats.distinctSessionsPerSecond?.min).toBeCloseTo(1000 / 1050, 6);
    });
});
