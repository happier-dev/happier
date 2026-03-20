import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { createServiceIpcContract } from './serviceIpcContract';
import { createServiceIpcHeartbeatHelper } from './serviceIpcHeartbeat';

describe('serviceIpcHeartbeat', () => {
    const serviceContract = createServiceIpcContract({
        service: 'test_worker',
        configSchema: z
            .object({
                watchMode: z.enum(['manual', 'watch_poll']),
                intervalMs: z.number().int().positive(),
            })
            .strict(),
        statusSchema: z
            .object({
                lifecycleState: z.enum(['starting', 'running', 'degraded']),
                detail: z.string().min(1).optional(),
            })
            .strict(),
    });

    it('creates and parses scoped heartbeat messages through one focused helper', () => {
        const helper = createServiceIpcHeartbeatHelper(serviceContract);

        const heartbeat = helper.create({ sentAtMs: 1200, sequence: 3 });

        expect(heartbeat).toEqual({
            service: 'test_worker',
            type: 'heartbeat',
            sentAtMs: 1200,
            sequence: 3,
        });

        expect(helper.parse(heartbeat)).toEqual(heartbeat);
    });

    it('rejects non-heartbeat messages when parsing heartbeat-specific payloads', () => {
        const helper = createServiceIpcHeartbeatHelper(serviceContract);

        expect(() =>
            helper.parse({
                service: 'test_worker',
                type: 'status_update',
                sentAtMs: 1200,
                sequence: 3,
                statusVersion: 2,
                status: {
                    lifecycleState: 'running',
                },
            }),
        ).toThrow();
    });

    it('reports heartbeat freshness from sentAtMs against a max age budget', () => {
        const helper = createServiceIpcHeartbeatHelper(serviceContract);
        const heartbeat = helper.create({ sentAtMs: 5_000, sequence: 4 });

        expect(helper.getAgeMs({ heartbeat, nowMs: 5_120 })).toBe(120);
        expect(helper.isFresh({ heartbeat, nowMs: 5_120, maxAgeMs: 120 })).toBe(true);
        expect(helper.isFresh({ heartbeat, nowMs: 5_121, maxAgeMs: 120 })).toBe(false);
    });

    it('treats future-dated heartbeat timestamps as invalid for freshness checks', () => {
        const helper = createServiceIpcHeartbeatHelper(serviceContract);
        const heartbeat = helper.create({ sentAtMs: 5_500, sequence: 4 });

        expect(helper.getAgeMs({ heartbeat, nowMs: 5_499 })).toBe(null);
        expect(helper.isFresh({ heartbeat, nowMs: 5_499, maxAgeMs: 100 })).toBe(false);
    });
});
