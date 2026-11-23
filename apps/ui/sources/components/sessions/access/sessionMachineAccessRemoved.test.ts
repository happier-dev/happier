import { describe, expect, it } from 'vitest';

import { isSessionMachineAccessRemoved } from './sessionMachineAccessRemoved';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

describe('isSessionMachineAccessRemoved', () => {
    it('publishes zero removals when an owner Machine leaves and returns to a settled inventory', () => {
        const session = createSessionFixture({ active: true });
        const inputs = [true, false, true].map(machinePresent => ({
            session, machineId: 'machine-a', inventorySettled: true, machinePresent,
        }));
        const results = inputs.map(isSessionMachineAccessRemoved);
        expect(results.filter(Boolean)).toHaveLength(0);
    });

    it('presents a guest withdrawal once from the typed stop reason, independent of inventory resolution', () => {
        const guest = createSessionFixture({ active: true, access: createSessionAccessFixture('edit'), accessLevel: 'edit' });
        const withdrawn = { ...guest, active: false, metadata: { ...guest.metadata!, lifecycleState: 'stopped' as const,
            lifecycleStateReason: 'machine_access_withdrawn' as const } };
        const inputs = [guest, withdrawn, withdrawn, withdrawn].map((session, index) => ({
            session, machineId: 'machine-a', inventorySettled: index !== 2, machinePresent: index !== 1,
        }));
        const results = inputs.map(isSessionMachineAccessRemoved);
        expect(results).toEqual([false, true, true, true]);
        expect(results.filter((removed, index) => removed && !results[index - 1])).toHaveLength(1);
    });
});
