import { describe, expect, it } from 'vitest';

import { createMachineFixture } from '@/dev/testkit';
import { resolveServerScopedMachine } from './resolveServerScopedMachine';

describe('resolveServerScopedMachine', () => {
    it('does not fall back to a global machine excluded by a settled scoped list', () => {
        const globalMachine = createMachineFixture();

        expect(resolveServerScopedMachine({
            machines: { 'machine-1': globalMachine },
            machineListByServerId: { 'server-owned': [] },
            machineListStatusByServerId: { 'server-owned': 'idle' },
        }, 'server-owned', 'machine-1')).toBeNull();
    });

    it('preserves the global fallback while a scoped machine list is still loading', () => {
        const globalMachine = createMachineFixture();

        expect(resolveServerScopedMachine({
            machines: { 'machine-1': globalMachine },
            machineListByServerId: { 'server-owned': null },
            machineListStatusByServerId: { 'server-owned': 'loading' },
        }, 'server-owned', 'machine-1')).toBe(globalMachine);
    });
});
