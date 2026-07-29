import { describe, expect, it, vi } from 'vitest';

import { createManagedHealthMonitor, type ManagedHealthMonitorService, type ManagedHealthTransition } from './healthMonitor';

function httpService(overrides: Partial<ManagedHealthMonitorService> = {}): ManagedHealthMonitorService {
    return {
        serviceKey: 'svc',
        runId: 1,
        pid: 300,
        host: '127.0.0.1',
        port: 45_100,
        startedAt: 0,
        healthCheck: { kind: 'http', path: '/healthz', timeoutMs: 50 },
        ...overrides,
    };
}

describe('createManagedHealthMonitor', () => {
    it('does not probe a route younger than the grace period', async () => {
        let clock = 0;
        const probe = vi.fn(async () => true);
        const monitor = createManagedHealthMonitor({ now: () => clock, graceMs: 5_000, probe, onTransition: () => {} });
        await monitor.tick([httpService({ startedAt: 0 })]);
        expect(probe).not.toHaveBeenCalled();
        clock = 6_000;
        await monitor.tick([httpService({ startedAt: 0 })]);
        expect(probe).toHaveBeenCalledTimes(1);
    });

    it('flips to unhealthy only after the failure threshold and recovers on success', async () => {
        let clock = 10_000;
        let healthy = false;
        const transitions: ManagedHealthTransition[] = [];
        const monitor = createManagedHealthMonitor({
            now: () => clock,
            graceMs: 5_000,
            failuresBeforeUnhealthy: 2,
            probe: async () => healthy,
            onTransition: (transition) => transitions.push(transition),
        });
        const service = httpService({ startedAt: 0 });

        await monitor.tick([service]); // failure 1 -> stays running, no transition
        expect(transitions).toHaveLength(0);
        await monitor.tick([service]); // failure 2 -> unhealthy
        expect(transitions.at(-1)).toMatchObject({ phase: 'unhealthy', pid: 300 });

        healthy = true;
        await monitor.tick([service]); // success -> running
        expect(transitions.at(-1)).toMatchObject({ phase: 'running', pid: 300 });
    });

    it('resets failure history when the run changes even if the pid is reused', async () => {
        const transitions: ManagedHealthTransition[] = [];
        const monitor = createManagedHealthMonitor({
            now: () => 10_000,
            graceMs: 5_000,
            failuresBeforeUnhealthy: 2,
            probe: async () => false,
            onTransition: (transition) => transitions.push(transition),
        });

        await monitor.tick([httpService({ runId: 1 })]);
        await monitor.tick([httpService({ runId: 2 })]);
        expect(transitions).toEqual([]);

        await monitor.tick([httpService({ runId: 2 })]);
        expect(transitions).toEqual([
            expect.objectContaining({
                runId: 2,
                pid: 300,
                phase: 'unhealthy',
            }),
        ]);
    });

    it('prunes a service that left the running set', async () => {
        let clock = 10_000;
        const monitor = createManagedHealthMonitor({ now: () => clock, graceMs: 5_000, probe: async () => true, onTransition: () => {} });
        await monitor.tick([httpService()]);
        expect(monitor.size()).toBe(1);
        await monitor.tick([]); // service gone
        expect(monitor.size()).toBe(0);
    });

    it('does not monitor non-http health checks', async () => {
        let clock = 10_000;
        const probe = vi.fn(async () => true);
        const monitor = createManagedHealthMonitor({ now: () => clock, graceMs: 5_000, probe, onTransition: () => {} });
        await monitor.tick([httpService({ healthCheck: { kind: 'none' } })]);
        expect(probe).not.toHaveBeenCalled();
        expect(monitor.size()).toBe(0);
    });
});
