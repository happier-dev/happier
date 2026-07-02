import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSyncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import { createJsThreadLagTelemetry } from './jsThreadLagTelemetry';

describe('createJsThreadLagTelemetry', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it('does not start when sync performance telemetry is disabled', () => {
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        const telemetry = createSyncPerformanceTelemetry({ enabled: false });
        const lagTelemetry = createJsThreadLagTelemetry({ telemetry });

        expect(lagTelemetry.start()).toBe(false);
        expect(lagTelemetry.isRunning()).toBe(false);
        expect(setTimeoutSpy).not.toHaveBeenCalled();
    });

    it('starts and stops idempotently', () => {
        const telemetry = createSyncPerformanceTelemetry({ enabled: true });
        const lagTelemetry = createJsThreadLagTelemetry({ telemetry });

        expect(lagTelemetry.start()).toBe(true);
        expect(lagTelemetry.start()).toBe(false);
        expect(lagTelemetry.isRunning()).toBe(true);

        lagTelemetry.stop();
        lagTelemetry.stop();
        expect(lagTelemetry.isRunning()).toBe(false);
    });

    it('records threshold counts with fake timers', async () => {
        let nowMs = 0;
        const telemetry = createSyncPerformanceTelemetry({ enabled: true });
        const lagTelemetry = createJsThreadLagTelemetry({
            telemetry,
            now: () => nowMs,
            sampleIntervalMs: 50,
            thresholdMs: 15,
            maxSamples: 8,
        });

        expect(lagTelemetry.start()).toBe(true);
        nowMs = 60;
        await vi.advanceTimersByTimeAsync(50);
        nowMs = 130;
        await vi.advanceTimersByTimeAsync(50);

        expect(lagTelemetry.snapshot()).toMatchObject({
            count: 2,
            p50Ms: 10,
            p99Ms: 20,
            maxMs: 20,
            thresholdExceededCount: 1,
            lastSampleAtMs: 130,
        });
    });

    it('does not accumulate old scheduling delay into later samples', async () => {
        let nowMs = 0;
        const telemetry = createSyncPerformanceTelemetry({ enabled: true });
        const lagTelemetry = createJsThreadLagTelemetry({
            telemetry,
            now: () => nowMs,
            sampleIntervalMs: 50,
            thresholdMs: 100,
            maxSamples: 8,
        });

        expect(lagTelemetry.start()).toBe(true);
        nowMs = 200;
        await vi.advanceTimersByTimeAsync(50);
        nowMs = 260;
        await vi.advanceTimersByTimeAsync(50);

        expect(lagTelemetry.snapshot()).toMatchObject({
            count: 2,
            p50Ms: 10,
            p99Ms: 150,
            maxMs: 150,
            thresholdExceededCount: 1,
            lastSampleAtMs: 260,
        });
    });

    it('realigns the active timer baseline when reset', async () => {
        let nowMs = 0;
        const telemetry = createSyncPerformanceTelemetry({ enabled: true });
        const lagTelemetry = createJsThreadLagTelemetry({
            telemetry,
            now: () => nowMs,
            sampleIntervalMs: 50,
            thresholdMs: 20,
            maxSamples: 8,
        });

        expect(lagTelemetry.start()).toBe(true);
        nowMs = 1_000;
        lagTelemetry.reset();
        nowMs = 1_060;
        await vi.advanceTimersByTimeAsync(50);

        expect(lagTelemetry.snapshot()).toMatchObject({
            count: 1,
            p50Ms: 10,
            p99Ms: 10,
            maxMs: 10,
            thresholdExceededCount: 0,
            lastSampleAtMs: 1_060,
        });
    });

    it('bounds samples and reset clears summaries', () => {
        const telemetry = createSyncPerformanceTelemetry({ enabled: true });
        const lagTelemetry = createJsThreadLagTelemetry({
            telemetry,
            thresholdMs: 2,
            maxSamples: 3,
        });

        lagTelemetry.recordSample(1, 10);
        lagTelemetry.recordSample(2, 20);
        lagTelemetry.recordSample(3, 30);
        lagTelemetry.recordSample(4, 40);

        expect(lagTelemetry.snapshot()).toMatchObject({
            count: 3,
            p50Ms: 3,
            p99Ms: 4,
            maxMs: 4,
            thresholdExceededCount: 2,
            lastSampleAtMs: 40,
        });

        lagTelemetry.reset();
        expect(lagTelemetry.snapshot()).toMatchObject({
            count: 0,
            p50Ms: 0,
            p99Ms: 0,
            maxMs: 0,
            thresholdExceededCount: 0,
            lastSampleAtMs: 0,
        });
    });

    it('flushes numeric-safe summary telemetry fields', () => {
        const telemetry = createSyncPerformanceTelemetry({ enabled: true });
        const lagTelemetry = createJsThreadLagTelemetry({
            telemetry,
            thresholdMs: 2,
        });

        lagTelemetry.recordSample(5, 50);
        lagTelemetry.flushSummary();

        expect(telemetry.snapshot().events).toEqual([
            expect.objectContaining({
                name: 'sync.runtime.jsThreadLag.summary',
                fields: {
                    count: 1,
                    p50Ms: 5,
                    p99Ms: 5,
                    maxMs: 5,
                    thresholdExceededCount: 1,
                    lastSampleAtMs: 50,
                },
            }),
        ]);
    });
});
