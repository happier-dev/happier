import { afterEach, describe, expect, it } from 'vitest';

import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import { recordSessionPayloadConsumptionTelemetry } from './sessionPayloadConsumptionTelemetry';

afterEach(() => {
    syncPerformanceTelemetry.configure({ enabled: false });
    syncPerformanceTelemetry.reset();
});

describe('session payload consumption telemetry', () => {
    it('records only numeric UTF-8 aggregate facts when explicitly enabled', () => {
        const payload = {
            statuses: [{ text: 'ready 💡' }],
            widgets: [{ lines: ['one', 'two'] }],
        };

        recordSessionPayloadConsumptionTelemetry({
            family: 'presentation',
            payload,
            itemCount: 2,
            lineCount: 3,
        });
        expect(syncPerformanceTelemetry.snapshot().events).toEqual([]);

        syncPerformanceTelemetry.configure({ enabled: true });
        recordSessionPayloadConsumptionTelemetry({
            family: 'presentation',
            payload,
            itemCount: 2,
            lineCount: 3,
        });

        const event = syncPerformanceTelemetry.snapshot().events[0];
        expect(event?.name).toBe('ui.session.payload.consume.presentation');
        expect(event?.fields).toEqual({
            payloadBytes: new TextEncoder().encode(JSON.stringify(payload)).byteLength,
            itemCount: 2,
            lineCount: 3,
        });
        expect(JSON.stringify(event)).not.toContain('ready');
    });
});
