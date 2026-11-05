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
