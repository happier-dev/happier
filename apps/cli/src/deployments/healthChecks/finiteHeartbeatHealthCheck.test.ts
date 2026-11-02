import { describe, expect, it } from 'vitest';
import { HealthCheckResultV1Schema } from '@happier-dev/deployment-protocol/v1';
import { readHeartbeatHealthCheckV1 } from './finiteHeartbeatHealthCheck';

describe('finite accepted-heartbeat age', () => {
    const check = { observer: { machineId: 'observer', installationId: 'installation' }, vantage: 'outside' as const,
        periodMs: 1000, graceMs: 200 };

    it('waits for the first accepted receipt without an enrollment-based outage or timer', () => {
        const observed = readHeartbeatHealthCheckV1({ ...check, lastAcceptedAt: null }, 100_000);
        expect(HealthCheckResultV1Schema.parse(observed.result).status).toBe('unknown');
        expect(observed.nextEligibleAt).toBeNull();
    });

    it('keeps equality healthy, wakes at the first late millisecond, and recovers only from a newer accepted receipt', () => {
        const atBoundary = readHeartbeatHealthCheckV1({ ...check, lastAcceptedAt: 1000 }, 2200);
        expect(atBoundary.result.status).toBe('up');
        expect(atBoundary.nextEligibleAt).toBe(2201);
        const late = readHeartbeatHealthCheckV1({ ...check, lastAcceptedAt: 1000 }, 2201);
        expect(late.result.status).toBe('down');
        expect(late.nextEligibleAt).toBe(3201);
        expect(readHeartbeatHealthCheckV1({ ...check, lastAcceptedAt: 2201 }, 2201).result.status).toBe('up');
    });
});
