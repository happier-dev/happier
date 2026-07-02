import { afterEach, describe, expect, it } from 'vitest';

import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { recordReactProfilerRenderTelemetry } from './SyncPerformanceReactProfiler';

describe('recordReactProfilerRenderTelemetry', () => {
    afterEach(() => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('records a namespaced render duration for enabled sync performance telemetry', () => {
        syncPerformanceTelemetry.configure({ enabled: true, slowThresholdMs: 1, flushIntervalMs: 30_000 });
        syncPerformanceTelemetry.reset();

        recordReactProfilerRenderTelemetry({
            id: 'sessions.list',
            phase: 'update',
            actualDuration: 12.5,
            baseDuration: 20,
            startTime: 100,
            commitTime: 118,
        });

        expect(syncPerformanceTelemetry.snapshot().events).toEqual([
            expect.objectContaining({
                name: 'ui.react.render.sessions.list',
                count: 1,
                totalMs: 12.5,
                fields: expect.objectContaining({
                    actualDurationMs: 12.5,
                    baseDurationMs: 20,
                    commitLagMs: 18,
                    mount: 0,
                    update: 1,
                }),
            }),
        ]);
    });
});
