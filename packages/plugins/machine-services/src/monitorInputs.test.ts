import { describe, expect, it } from 'vitest';
import { normalizeGatusInput, normalizeUptimeKumaInput } from './monitorInputs.js';

describe('named monitor provider vectors', () => {
    // Uptime Kuma 1.23.16 server/notification-providers/webhook.js and model/heartbeat.js.
    it('maps Kuma raw JSON status and identity while excluding unknown, test and mismatched monitors', () => {
        const input = { monitor: { id: 7, name: 'Shop' }, heartbeat: {
            monitorID: 7, status: 0, time: '2026-11-10 10:00:00.000', msg: 'private detail',
        }, msg: 'private notification body' };
        const down = normalizeUptimeKumaInput(input, Date.UTC(2026, 10, 10, 10, 0, 1));
        expect(down).toMatchObject({ monitorId: '7', result: { status: 'down', observedAt: Date.UTC(2026, 10, 10, 10) } });
        expect(JSON.stringify(down)).not.toContain('private');
        expect(normalizeUptimeKumaInput({ ...input, heartbeat: { ...input.heartbeat, status: 1 } }, 1)?.result.status).toBe('up');
        for (const value of [null, { monitor: null, heartbeat: null },
            { ...input, heartbeat: { ...input.heartbeat, status: 2 } },
            { ...input, heartbeat: { ...input.heartbeat, status: 3 } },
            { ...input, heartbeat: { ...input.heartbeat, monitorID: 8 } },
            { ...input, heartbeat: { ...input.heartbeat, time: 'unknown' } }]) {
            expect(normalizeUptimeKumaInput(value, 1)).toBeNull();
        }
    });

    // Gatus v5.16.0 custom provider substitutes these three placeholders. No vendor timestamp exists.
    it('maps only the documented Gatus custom JSON template using server receipt time', () => {
        const input = { endpointGroup: 'Production', endpointName: 'Shop', status: 'TRIGGERED' };
        expect(normalizeGatusInput(input, 200)).toMatchObject({ monitorId: '["Production","Shop"]',
            result: { status: 'down', observedAt: 200 } });
        expect(normalizeGatusInput({ ...input, status: 'RESOLVED' }, 300)?.result).toMatchObject({ status: 'up', observedAt: 300 });
        for (const value of [{ ...input, status: 'UNKNOWN' }, { ...input, endpointName: '' },
            { ...input, status: true }, { status: 'RESOLVED' }]) {
            expect(normalizeGatusInput(value, 300)).toBeNull();
        }
    });
});
