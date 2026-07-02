import { afterEach, describe, expect, it, vi } from 'vitest';

import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import {
    clearSessionUiTelemetryMarks,
    clearStreamingSessionUiTelemetryMarks,
    markSessionOpenRequestedForSessionUiTelemetry,
    markSessionRouteEnteredForSessionUiTelemetry,
    markStreamingMessagesAppliedForSessionUiTelemetry,
    recordSessionOpenPaintForSessionUiTelemetry,
    recordStreamingVisibleUpdateForSessionUiTelemetry,
} from './sessionUiTelemetry';

describe('session UI telemetry markers', () => {
    afterEach(() => {
        vi.restoreAllMocks();
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

    it('records session open to transcript paint latency without logging session ids', () => {
        let nowMs = 1_000;
        vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        markSessionOpenRequestedForSessionUiTelemetry({
            sessionId: 'secret-session-id',
            source: 'navigate-hook',
        });

        nowMs = 1_250;
        recordSessionOpenPaintForSessionUiTelemetry({
            committedMessages: 12,
            distanceFromBottom: 0,
            items: 4,
            native: 1,
            phase: 'firstPaint',
            routeHydrationPending: 0,
            sessionId: 'secret-session-id',
            web: 0,
        });

        nowMs = 1_700;
        recordSessionOpenPaintForSessionUiTelemetry({
            committedMessages: 12,
            distanceFromBottom: 0,
            items: 4,
            native: 1,
            phase: 'stablePaint',
            routeHydrationPending: 0,
            sessionId: 'secret-session-id',
            web: 0,
        });

        expect(syncPerformanceTelemetry.snapshot().events).toEqual([
            expect.objectContaining({
                name: 'ui.sessions.transcript.openToFirstPaint',
                totalMs: 250,
                fields: expect.objectContaining({
                    committedMessages: 12,
                    distanceFromBottom: 0,
                    items: 4,
                    native: 1,
                    sourceNavigateHook: 1,
                    sourceUnknown: 0,
                    web: 0,
                }),
            }),
            expect.objectContaining({
                name: 'ui.sessions.transcript.openToStablePaint',
                totalMs: 700,
                fields: expect.objectContaining({
                    committedMessages: 12,
                    distanceFromBottom: 0,
                    items: 4,
                    native: 1,
                    sourceNavigateHook: 1,
                    sourceUnknown: 0,
                    web: 0,
                }),
            }),
        ]);
        expect(JSON.stringify(syncPerformanceTelemetry.snapshot().events)).not.toContain('secret-session-id');
    });

    it('records each session open paint phase only once per navigation mark', () => {
        let nowMs = 2_000;
        vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        markSessionOpenRequestedForSessionUiTelemetry({
            sessionId: 's1',
            source: 'navigate-hook',
        });

        nowMs = 2_100;
        recordSessionOpenPaintForSessionUiTelemetry({
            committedMessages: 1,
            items: 1,
            native: 0,
            phase: 'firstPaint',
            routeHydrationPending: 0,
            sessionId: 's1',
            web: 1,
        });
        nowMs = 2_200;
        recordSessionOpenPaintForSessionUiTelemetry({
            committedMessages: 1,
            items: 1,
            native: 0,
            phase: 'firstPaint',
            routeHydrationPending: 0,
            sessionId: 's1',
            web: 1,
        });

        expect(syncPerformanceTelemetry.snapshot().events).toHaveLength(1);
        expect(syncPerformanceTelemetry.snapshot().events[0]?.name).toBe('ui.sessions.transcript.openToFirstPaint');
    });

    it('uses a route-entry mark for direct session routes without overwriting navigate-hook marks', () => {
        let nowMs = 3_000;
        vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        markSessionRouteEnteredForSessionUiTelemetry({ sessionId: 'direct-session' });
        nowMs = 3_180;
        recordSessionOpenPaintForSessionUiTelemetry({
            committedMessages: 1,
            items: 1,
            native: 1,
            phase: 'firstPaint',
            routeHydrationPending: 1,
            sessionId: 'direct-session',
            web: 0,
        });

        nowMs = 4_000;
        markSessionOpenRequestedForSessionUiTelemetry({
            sessionId: 'navigated-session',
            source: 'navigate-hook',
        });
        nowMs = 4_100;
        markSessionRouteEnteredForSessionUiTelemetry({ sessionId: 'navigated-session' });
        nowMs = 4_300;
        recordSessionOpenPaintForSessionUiTelemetry({
            committedMessages: 2,
            items: 2,
            native: 0,
            phase: 'firstPaint',
            routeHydrationPending: 0,
            sessionId: 'navigated-session',
            web: 1,
        });

        expect(syncPerformanceTelemetry.snapshot().events).toEqual([
            expect.objectContaining({
                name: 'ui.sessions.transcript.openToFirstPaint',
                count: 2,
                totalMs: 480,
                fieldStats: expect.objectContaining({
                    sourceRouteEntry: expect.objectContaining({ last: 0, max: 1 }),
                    sourceNavigateHook: expect.objectContaining({ last: 1, max: 1 }),
                }),
            }),
        ]);
    });

    it('clears streaming marks on transcript unmount without losing pending open-to-paint marks', () => {
        let nowMs = 5_000;
        vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        markSessionOpenRequestedForSessionUiTelemetry({
            sessionId: 'warm-session',
            source: 'navigate-hook',
        });
        markStreamingMessagesAppliedForSessionUiTelemetry({
            sessionId: 'warm-session',
            source: 'socketMessage',
            messages: [
                { id: 'message-1' },
            ],
        });

        clearStreamingSessionUiTelemetryMarks('warm-session');

        nowMs = 5_240;
        recordStreamingVisibleUpdateForSessionUiTelemetry({
            committedMessages: 1,
            latestMessageId: 'message-1',
            sessionId: 'warm-session',
            transcriptLoaded: 1,
            visibleItems: 1,
        });
        recordSessionOpenPaintForSessionUiTelemetry({
            committedMessages: 1,
            distanceFromBottom: 0,
            items: 1,
            native: 1,
            phase: 'stablePaint',
            routeHydrationPending: 0,
            sessionId: 'warm-session',
            web: 0,
        });

        const events = syncPerformanceTelemetry.snapshot().events;
        expect(events.some((event) => event.name === 'ui.sessions.streaming.visibleUpdate')).toBe(false);
        expect(events).toEqual([
            expect.objectContaining({
                name: 'ui.sessions.transcript.openToStablePaint',
                totalMs: 240,
                fields: expect.objectContaining({
                    native: 1,
                    sourceNavigateHook: 1,
                    web: 0,
                }),
            }),
        ]);
    });
});
