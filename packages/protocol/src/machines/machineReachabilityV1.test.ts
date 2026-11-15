import { describe, expect, it } from 'vitest';
import { isMachineOnlineV1, isMachineReachableV1 } from './machineReachabilityV1.js';

describe('Home-owned Machine presence', () => {
    const homePresence = { presenceProtocolVersion: 1 as const };

    it('keeps the incumbent 60000 ms grace without a Home presence fact', () => {
        expect(isMachineOnlineV1({ active: false, activeAt: 100_000 }, 160_000)).toBe(true);
        expect(isMachineOnlineV1({ active: true, activeAt: 100_000 }, 160_001)).toBe(false);
    });

    it('uses the Home active/inactive fact independently of daemon capabilities', () => {
        expect(isMachineOnlineV1({ active: true, activeAt: 1, ...homePresence }, 1_000_000)).toBe(true);
        expect(isMachineOnlineV1({ active: false, activeAt: 1_000_000, ...homePresence }, 1_000_000)).toBe(false);
        expect(isMachineOnlineV1({ active: true, ...homePresence, revokedAt: 1 }, 1_000_000)).toBe(false);
        expect(isMachineReachableV1({ machine: { active: true, ...homePresence }, requestOutcome: 'failed' })).toBe(false);
    });
});

describe('Machine heartbeat cadence (ruling 2026-11-04 (3))', () => {
    it('beats 5 times per idle 5 minutes and declares a Machine offline after three missed beats', async () => {
        const { MACHINE_HEARTBEAT_INTERVAL_MS, DEFAULT_MACHINE_PRESENCE_TIMEOUT_MS } = await import('./machineReachabilityV1.js');
        expect({ beatsPerFiveIdleMinutes: Math.floor(5 * 60_000 / MACHINE_HEARTBEAT_INTERVAL_MS), offlineAfterMs: DEFAULT_MACHINE_PRESENCE_TIMEOUT_MS })
            .toEqual({ beatsPerFiveIdleMinutes: 5, offlineAfterMs: 180_000 });
    });
});
