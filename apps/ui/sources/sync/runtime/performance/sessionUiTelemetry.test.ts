import { afterEach, describe, expect, it } from 'vitest';

import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import {
    clearSessionUiTelemetryMarks,
    markStreamingMessagesAppliedForSessionUiTelemetry,
    recordStreamingVisibleUpdateForSessionUiTelemetry,
} from './sessionUiTelemetry';

describe('session UI telemetry markers', () => {
    afterEach(() => {
        clearSessionUiTelemetryMarks();
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('records visible streaming update latency with numeric fields when enabled', () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        markStreamingMessagesAppliedForSessionUiTelemetry({
            sessionId: 's1',
            source: 'transcriptStreamSegment',
            messages: [
                { id: 'm1' },
            ],
        });

        recordStreamingVisibleUpdateForSessionUiTelemetry({
            sessionId: 's1',
            latestMessageId: 'm1',
            committedMessages: 1,
            visibleItems: 1,
            transcriptLoaded: 1,
        });

        const event = syncPerformanceTelemetry
            .snapshot()
            .events.find((candidate) => candidate.name === 'ui.sessions.streaming.visibleUpdate');

        expect(event).toBeTruthy();
        expect(event?.fields).toMatchObject({
            messages: 1,
            visibleItems: 1,
            committedMessages: 1,
            transcriptLoaded: 1,
            sourceTranscriptStreamSegment: 1,
            sourceSocketMessage: 0,
        });
        expect(Object.values(event?.fields ?? {}).every((value) => typeof value === 'number')).toBe(true);
    });

    it('does not record visible streaming update latency when telemetry is disabled', () => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();

        markStreamingMessagesAppliedForSessionUiTelemetry({
            sessionId: 's1',
            source: 'socketMessage',
            messages: [
                { id: 'm1' },
            ],
        });
        recordStreamingVisibleUpdateForSessionUiTelemetry({
            sessionId: 's1',
            latestMessageId: 'm1',
            committedMessages: 1,
            visibleItems: 1,
            transcriptLoaded: 1,
        });

        expect(syncPerformanceTelemetry.snapshot().events).toEqual([]);
    });
});
