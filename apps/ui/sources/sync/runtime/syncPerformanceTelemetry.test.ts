import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createSyncPerformanceTelemetry,
    emitSyncPerformanceSummaryToConsole,
} from './syncPerformanceTelemetry';

describe('sync performance telemetry', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not record spans while disabled', () => {
        const telemetry = createSyncPerformanceTelemetry({
            enabled: false,
            now: () => 10,
        });

        telemetry.recordDuration('sync.sessions.apply', 12, { sessions: 3 });

        expect(telemetry.snapshot().events).toEqual([]);
    });

    it('aggregates durations and numeric fields when enabled', () => {
        let now = 100;
        const telemetry = createSyncPerformanceTelemetry({
            enabled: true,
            slowThresholdMs: 20,
            now: () => now,
        });

        telemetry.recordDuration('sync.sessions.apply', 12, { sessions: 3 });
        telemetry.recordDuration('sync.sessions.apply', 28, { sessions: 5, ignored: 'x' });

        const measured = telemetry.measure('sync.messages.apply', { messages: 2 }, () => {
            now = 141;
            return 'ok';
        });

        expect(measured).toBe('ok');
        expect(telemetry.snapshot().events).toEqual([
            {
                name: 'sync.sessions.apply',
                count: 2,
                totalMs: 40,
                minMs: 12,
                maxMs: 28,
                p50Ms: 16,
                p90Ms: 64,
                p99Ms: 64,
                slowCount: 1,
                durationBuckets: { '16': 1, '64': 1 },
                fields: { sessions: 8 },
                fieldStats: {
                    sessions: { sum: 8, min: 3, max: 5, last: 5 },
                },
            },
            {
                name: 'sync.messages.apply',
                count: 1,
                totalMs: 41,
                minMs: 41,
                maxMs: 41,
                p50Ms: 64,
                p90Ms: 64,
                p99Ms: 64,
                slowCount: 1,
                durationBuckets: { '64': 1 },
                fields: { messages: 2 },
                fieldStats: {
                    messages: { sum: 2, min: 2, max: 2, last: 2 },
                },
            },
        ]);
    });

    it('keeps field max and last values for repeated static knobs', () => {
        const telemetry = createSyncPerformanceTelemetry({
            enabled: true,
            now: () => 0,
        });

        telemetry.recordDuration('sync.encryption.crypto.aes.decrypt', 12, { items: 4, concurrency: 4 });
        telemetry.recordDuration('sync.encryption.crypto.aes.decrypt', 18, { items: 2, concurrency: 4 });

        expect(telemetry.snapshot().events).toEqual([{
            name: 'sync.encryption.crypto.aes.decrypt',
            count: 2,
            totalMs: 30,
            minMs: 12,
            maxMs: 18,
            p50Ms: 16,
            p90Ms: 64,
            p99Ms: 64,
            slowCount: 0,
            durationBuckets: { '16': 1, '64': 1 },
            fields: { items: 6, concurrency: 8 },
            fieldStats: {
                items: { sum: 6, min: 2, max: 4, last: 2 },
                concurrency: { sum: 8, min: 4, max: 4, last: 4 },
            },
        }]);
    });

    it('flushes a summary and resets collected events', () => {
        const telemetry = createSyncPerformanceTelemetry({
            enabled: true,
            now: () => 0,
        });

        telemetry.recordDuration('sync.socket.event', 6, { events: 1 });

        const flushed = telemetry.flushSummary();

        expect(flushed?.events).toHaveLength(1);
        expect(telemetry.snapshot().events).toEqual([]);
    });

    it('flushes a pending burst on a timer without requiring another event', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const emitSummary = vi.fn();
        const telemetry = createSyncPerformanceTelemetry({
            enabled: true,
            flushIntervalMs: 1000,
            now: () => Date.now(),
            emitSummary,
        });

        telemetry.recordDuration('sync.sessions.open', 12, { sessions: 1 });

        vi.advanceTimersByTime(999);
        expect(emitSummary).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);

        expect(emitSummary).toHaveBeenCalledTimes(1);
        expect(emitSummary).toHaveBeenCalledWith({
            events: [
                expect.objectContaining({
                    name: 'sync.sessions.open',
                    count: 1,
                    totalMs: 12,
                    p99Ms: 16,
                }),
            ],
        });
        expect(telemetry.snapshot().events).toEqual([]);
    });


    it('emits summaries through the native logging hook when available', () => {
        const target = globalThis as unknown as {
            nativeLoggingHook?: (message: string, level: number) => void;
        };
        const previousHook = target.nativeLoggingHook;
        const nativeLoggingHook = vi.fn();
        target.nativeLoggingHook = nativeLoggingHook;

        emitSyncPerformanceSummaryToConsole({
            events: [{
                name: 'sync.sessions.apply',
                count: 1,
                totalMs: 12,
                minMs: 12,
                maxMs: 12,
                p50Ms: 16,
                p90Ms: 16,
                p99Ms: 16,
                slowCount: 0,
                durationBuckets: { '16': 1 },
                fields: { sessions: 3 },
                fieldStats: {
                    sessions: { sum: 3, min: 3, max: 3, last: 3 },
                },
            }],
        });

        expect(nativeLoggingHook).toHaveBeenCalledWith(
            '[sync-perf] {"events":[{"name":"sync.sessions.apply","count":1,"totalMs":12,"minMs":12,"maxMs":12,"p50Ms":16,"p90Ms":16,"p99Ms":16,"slowCount":0,"durationBuckets":{"16":1},"fields":{"sessions":3},"fieldStats":{"sessions":{"sum":3,"min":3,"max":3,"last":3}}}]}',
            1,
        );
        target.nativeLoggingHook = previousHook;
    });

    it('emits native summaries as one logcat-safe line per event', () => {
        const target = globalThis as unknown as {
            nativeLoggingHook?: (message: string, level: number) => void;
        };
        const previousHook = target.nativeLoggingHook;
        const nativeLoggingHook = vi.fn();
        target.nativeLoggingHook = nativeLoggingHook;

        emitSyncPerformanceSummaryToConsole({
            events: [
                {
                    name: 'sync.sessions.apply',
                    count: 1,
                    totalMs: 12,
                    minMs: 12,
                    maxMs: 12,
                    p50Ms: 16,
                    p90Ms: 16,
                    p99Ms: 16,
                    slowCount: 0,
                    durationBuckets: { '16': 1 },
                    fields: {},
                    fieldStats: {},
                },
                {
                    name: 'sync.sessions.render',
                    count: 1,
                    totalMs: 3,
                    minMs: 3,
                    maxMs: 3,
                    p50Ms: 4,
                    p90Ms: 4,
                    p99Ms: 4,
                    slowCount: 0,
                    durationBuckets: { '4': 1 },
                    fields: {},
                    fieldStats: {},
                },
            ],
        });

        expect(nativeLoggingHook).toHaveBeenCalledTimes(2);
        expect(nativeLoggingHook.mock.calls[0]?.[0]).toContain('"name":"sync.sessions.apply"');
        expect(nativeLoggingHook.mock.calls[0]?.[0]).not.toContain('"name":"sync.sessions.render"');
        expect(nativeLoggingHook.mock.calls[1]?.[0]).toContain('"name":"sync.sessions.render"');
        target.nativeLoggingHook = previousHook;
    });

    it('falls back to console summaries as JSON so native logs preserve nested fields', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

        emitSyncPerformanceSummaryToConsole({
            events: [{
                name: 'sync.sessions.apply',
                count: 1,
                totalMs: 12,
                minMs: 12,
                maxMs: 12,
                p50Ms: 16,
                p90Ms: 16,
                p99Ms: 16,
                slowCount: 0,
                durationBuckets: { '16': 1 },
                fields: { sessions: 3 },
                fieldStats: {
                    sessions: { sum: 3, min: 3, max: 3, last: 3 },
                },
            }],
        });

        expect(info).toHaveBeenCalledWith(
            '[sync-perf]',
            '{"events":[{"name":"sync.sessions.apply","count":1,"totalMs":12,"minMs":12,"maxMs":12,"p50Ms":16,"p90Ms":16,"p99Ms":16,"slowCount":0,"durationBuckets":{"16":1},"fields":{"sessions":3},"fieldStats":{"sessions":{"sum":3,"min":3,"max":3,"last":3}}}]}',
        );
        info.mockRestore();
    });

    it('approximates p99 from fixed duration buckets without retaining raw samples', () => {
        const telemetry = createSyncPerformanceTelemetry({ enabled: true, now: () => 0 });

        for (const duration of [0, 1, 2, 15, 16, 17, 63, 64, 65, 255, 256, 257]) {
            telemetry.recordDuration('sync.crypto.worker.probe', duration);
        }

        expect(telemetry.snapshot().events).toEqual([
            expect.objectContaining({
                name: 'sync.crypto.worker.probe',
                count: 12,
                durationBuckets: {
                    '1': 2,
                    '4': 1,
                    '16': 2,
                    '64': 3,
                    '256': 3,
                    '1024': 1,
                },
                p50Ms: 64,
                p90Ms: 256,
                p99Ms: 1024,
            }),
        ]);
    });
});
