import { describe, expect, it } from 'vitest';

import { resolveSessionMachineReachability } from '@/components/sessions/model/resolveSessionMachineReachability';

describe('resolveSessionMachineReachability', () => {
    it('treats an unknown machine as reachable (avoids false "offline: unknown")', () => {
        expect(resolveSessionMachineReachability({
            machineIsKnown: false,
            machineIsOnline: false,
        })).toBe(true);
    });

    it('returns true when machine is known and online', () => {
        expect(resolveSessionMachineReachability({
            machineIsKnown: true,
            machineIsOnline: true,
        })).toBe(true);
    });

    it('returns false when machine is known and offline', () => {
        expect(resolveSessionMachineReachability({
            machineIsKnown: true,
            machineIsOnline: false,
        })).toBe(false);
    });
});

