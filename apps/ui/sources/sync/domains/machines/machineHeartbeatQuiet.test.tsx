import { act } from 'react-test-renderer';
import { expect, it } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useMachine, useServerScopedMachine } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

// Whole-record Machine readers observe facts, not the presence clock: a heartbeat is
// published by the machine-domain activity owner and never replaces the record.
it('does not redraw whole-record Machine readers for heartbeats on either ingress', async () => {
    const store = getStorage();
    const previous = store.getState();
    const serverId = getActiveServerSnapshot().serverId;
    const machine = createMachineFixture({ id: 'hb-1', active: true, activeAt: 1_000, updatedAt: 1_000 });
    store.getState().applyMachines([machine], true, { sourceServerId: serverId });
    let scopedRenders = 0;
    let plainRenders = 0;
    const scoped = await renderHook(() => { scopedRenders += 1; return useServerScopedMachine(serverId, machine.id); });
    const plain = await renderHook(() => { plainRenders += 1; return useMachine(machine.id); });
    try {
        scopedRenders = 0; plainRenders = 0;
        for (const activeAt of [2_000, 3_000]) {
            await act(async () => store.getState().applyMachineActivityUpdates([{ id: machine.id, active: true, activeAt }], { sourceServerId: serverId }));
        }
        for (const activeAt of [4_000, 5_000]) {
            await act(async () => store.getState().applyMachines([{ ...machine, activeAt, updatedAt: activeAt }], false, { sourceServerId: serverId }));
        }
        expect({ scopedRenders, plainRenders }).toEqual({ scopedRenders: 0, plainRenders: 0 });
        await act(async () => store.getState().applyMachines([{ ...machine, activeAt: 6_000, updatedAt: 6_000, metadataVersion: 2,
            metadata: { ...machine.metadata!, displayName: 'Renamed' } }], false, { sourceServerId: serverId }));
        expect({ scopedRenders, plainRenders }).toEqual({ scopedRenders: 1, plainRenders: 1 });
    } finally {
        await scoped.unmount(); await plain.unmount();
        store.setState(previous);
    }
});
