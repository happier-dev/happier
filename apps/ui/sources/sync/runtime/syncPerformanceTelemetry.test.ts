import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createSyncPerformanceTelemetry,
    emitSyncPerformanceSummaryToConsole,
    installSyncPerformanceTelemetryGlobal,
    registerSyncPerformanceTelemetryGlobalLifecycleHooks,
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

    it('exposes a global scenario marker for profiling run context', () => {
        const target = globalThis as unknown as {
            __HAPPIER_SYNC_PERFORMANCE__?: {
                markScenario?: (name: string, fields?: Readonly<Record<string, unknown>>) => void;
            };
        };
        const previousGlobal = target.__HAPPIER_SYNC_PERFORMANCE__;
        const telemetry = createSyncPerformanceTelemetry({
            enabled: true,
            now: () => 0,
        });

        installSyncPerformanceTelemetryGlobal(telemetry);
        target.__HAPPIER_SYNC_PERFORMANCE__?.markScenario?.('Session List: 10 streams', {
            concurrentStreamingSessions: 10,
            screenSessionList: 1,
            ignoredLabel: 'not numeric',
        });

        expect(telemetry.snapshot().events).toEqual([
            expect.objectContaining({
                name: 'sync.performance.scenario.session-list-10-streams',
                count: 1,
                fields: {
                    concurrentStreamingSessions: 10,
                    screenSessionList: 1,
                },
            }),
        ]);
        target.__HAPPIER_SYNC_PERFORMANCE__ = previousGlobal;
    });

    it('lets global collection controls flush and reset extension telemetry', () => {
        const target = globalThis as unknown as {
            __HAPPIER_SYNC_PERFORMANCE__?: {
                snapshot: () => ReturnType<ReturnType<typeof createSyncPerformanceTelemetry>['snapshot']>;
                flush: () => ReturnType<ReturnType<typeof createSyncPerformanceTelemetry>['flushSummary']>;
                reset: () => void;
            };
        };
        const previousGlobal = target.__HAPPIER_SYNC_PERFORMANCE__;
        const telemetry = createSyncPerformanceTelemetry({
            enabled: true,
            now: () => 0,
        });
        let pendingExtensionEvents = 0;
        let resetCount = 0;
        const unregister = registerSyncPerformanceTelemetryGlobalLifecycleHooks({
            telemetry,
            beforeCollect: () => {
                if (pendingExtensionEvents === 0) return;
                telemetry.count('sync.extension.pendingWindow', { pendingExtensionEvents });
                pendingExtensionEvents = 0;
            },
            reset: () => {
                pendingExtensionEvents = 0;
                resetCount += 1;
            },
        });

        installSyncPerformanceTelemetryGlobal(telemetry);
        pendingExtensionEvents = 2;

        expect(target.__HAPPIER_SYNC_PERFORMANCE__?.snapshot().events).toContainEqual(expect.objectContaining({
            name: 'sync.extension.pendingWindow',
            fields: { pendingExtensionEvents: 2 },
        }));

        pendingExtensionEvents = 1;
        expect(target.__HAPPIER_SYNC_PERFORMANCE__?.flush()?.events).toContainEqual(expect.objectContaining({
            name: 'sync.extension.pendingWindow',
            fields: { pendingExtensionEvents: 3 },
            fieldStats: {
                pendingExtensionEvents: {
                    sum: 3,
                    min: 1,
                    max: 2,
                    last: 1,
                },
            },
        }));
        expect(resetCount).toBe(1);
        expect(telemetry.snapshot().events).toEqual([]);

        pendingExtensionEvents = 3;
        target.__HAPPIER_SYNC_PERFORMANCE__?.reset();
        expect(resetCount).toBe(2);
        expect(target.__HAPPIER_SYNC_PERFORMANCE__?.snapshot().events).toEqual([]);

        unregister();
        target.__HAPPIER_SYNC_PERFORMANCE__ = previousGlobal;
    });

    it('lets dev QA enable sync performance telemetry in an already-running runtime', () => {
        const target = globalThis as unknown as {
            __HAPPIER_SYNC_PERFORMANCE__?: {
                configure?: (options: { enabled?: boolean; slowThresholdMs?: number; flushIntervalMs?: number }) => void;
                snapshot: () => ReturnType<ReturnType<typeof createSyncPerformanceTelemetry>['snapshot']>;
            };
        };
        const previousGlobal = target.__HAPPIER_SYNC_PERFORMANCE__;
        vi.stubGlobal('__DEV__', true);
        const telemetry = createSyncPerformanceTelemetry({
            enabled: false,
            now: () => 0,
        });

        installSyncPerformanceTelemetryGlobal(telemetry);
        target.__HAPPIER_SYNC_PERFORMANCE__?.configure?.({
            enabled: true,
            flushIntervalMs: 120_000,
            slowThresholdMs: 16,
        });
        telemetry.recordDuration('ui.sessions.transcript.openToStablePaint', 24, {
            native: 1,
        });

        expect(target.__HAPPIER_SYNC_PERFORMANCE__?.snapshot().events).toEqual([
            expect.objectContaining({
                name: 'ui.sessions.transcript.openToStablePaint',
                slowCount: 1,
                fields: { native: 1 },
            }),
        ]);

        target.__HAPPIER_SYNC_PERFORMANCE__ = previousGlobal;
        vi.unstubAllGlobals();
    });

    it('does not expose runtime telemetry configuration outside dev', () => {
        const target = globalThis as unknown as {
            __HAPPIER_SYNC_PERFORMANCE__?: {
                configure?: (options: { enabled?: boolean }) => void;
                snapshot: () => ReturnType<ReturnType<typeof createSyncPerformanceTelemetry>['snapshot']>;
            };
        };
        const previousGlobal = target.__HAPPIER_SYNC_PERFORMANCE__;
        vi.stubGlobal('__DEV__', false);
        const telemetry = createSyncPerformanceTelemetry({
            enabled: false,
            now: () => 0,
        });

        installSyncPerformanceTelemetryGlobal(telemetry);
        expect(target.__HAPPIER_SYNC_PERFORMANCE__?.configure).toBeUndefined();

        target.__HAPPIER_SYNC_PERFORMANCE__ = previousGlobal;
        vi.unstubAllGlobals();
    });

    it('collects per-instance extension telemetry during nested collection', () => {
        const outerTelemetry = createSyncPerformanceTelemetry({
            enabled: true,
            now: () => 0,
        });
        const innerTelemetry = createSyncPerformanceTelemetry({
            enabled: true,
            now: () => 0,
        });
        const nestedSummaries: Array<ReturnType<typeof innerTelemetry.snapshot>> = [];
        const unregisterInner = registerSyncPerformanceTelemetryGlobalLifecycleHooks({
            telemetry: innerTelemetry,
            beforeCollect: () => {
                innerTelemetry.count('sync.extension.innerPendingWindow', { collected: 1 });
            },
        });
        const unregisterOuter = registerSyncPerformanceTelemetryGlobalLifecycleHooks({
            telemetry: outerTelemetry,
            beforeCollect: () => {
                nestedSummaries.push(innerTelemetry.snapshot());
            },
        });

        outerTelemetry.snapshot();

        expect(nestedSummaries[0]?.events).toContainEqual(expect.objectContaining({
            name: 'sync.extension.innerPendingWindow',
            fields: { collected: 1 },
        }));

        unregisterOuter();
        unregisterInner();
    });

    it('collects extension telemetry from direct snapshot and flush calls', () => {
        const telemetry = createSyncPerformanceTelemetry({
            enabled: true,
            now: () => 0,
        });
        let pendingExtensionEvents = 0;
        const unregister = registerSyncPerformanceTelemetryGlobalLifecycleHooks({
            telemetry,
            beforeCollect: () => {
                if (pendingExtensionEvents === 0) return;
                telemetry.count('sync.extension.directPendingWindow', { pendingExtensionEvents });
                pendingExtensionEvents = 0;
            },
        });

        pendingExtensionEvents = 2;
        expect(telemetry.snapshot().events).toContainEqual(expect.objectContaining({
            name: 'sync.extension.directPendingWindow',
            fields: { pendingExtensionEvents: 2 },
        }));

        pendingExtensionEvents = 1;
        expect(telemetry.flushSummary()?.events).toContainEqual(expect.objectContaining({
            name: 'sync.extension.directPendingWindow',
            fields: { pendingExtensionEvents: 3 },
            fieldStats: {
                pendingExtensionEvents: {
                    sum: 3,
                    min: 1,
                    max: 2,
                    last: 1,
                },
            },
        }));
        expect(telemetry.snapshot().events).toEqual([]);

        unregister();
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
