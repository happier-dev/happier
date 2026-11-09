import { expect, it } from 'vitest';

import { createMachineFixture } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { sync } = await import('@/sync/syncEngine');
const { carryMachineActivity, linkMachineActivity, readMachineActivity, subscribeMachineActivity } =
    await import('@/sync/domains/machines/machineActivity');

it.each(['activity', 'row'] as const)('settles %s inactivity and sign-out with retained Machines and live subscriptions', async ingress => {
    const home = 'srv_presence-reset';
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://presence-reset.test', serverIdentityId: home });
    const options = { sourceServerId: home };
    const initial = createMachineFixture({ id: 'retained', active: true, activeAt: Date.now(), presenceProtocolVersion: 1 });
    storage.getState().applyMachines([initial], true, options);
    const held = storage.getState().machines[initial.id]!;
    const display = storage.getState().machineDisplayById[initial.id]!;
    const projection = { ...held };
    linkMachineActivity(held, projection);
    // Inventory/collection retention can revisit the same row and rejoin an alias.
    carryMachineActivity(held, held);
    carryMachineActivity(held, projection);
    linkMachineActivity(projection, held);
    const observed: boolean[] = [];
    const stopActivity = subscribeMachineActivity(display, () => {
        const activity = readMachineActivity(projection);
        observed.push(activity.active);
        // A live reader may reconcile the observation it just received.
        storage.getState().applyMachineActivityUpdates([{ id: held.id, active: activity.active, activeAt: activity.activeAt! }], options);
    });
    const resetPresence: boolean[] = [];
    const stopStore = storage.subscribe(state => {
        if (Object.keys(state.machines).length === 0) {
            resetPresence.push(readMachineActivity(display).active);
        }
    });
    try {
        const offline = { id: held.id, active: false, activeAt: held.activeAt };
        if (ingress === 'activity') storage.getState().applyMachineActivityUpdates([offline], options);
        else storage.getState().applyMachines([{ ...held, ...offline }], false, options);
        expect(observed).toEqual([false]);
        for (let repeat = 0; repeat < 3; repeat++) storage.getState().applyMachineActivityUpdates([offline], options);
        expect(observed).toEqual([false]);
        expect(storage.getState().machines[held.id]).toBe(held);
        sync.disconnectServer();
        sync.disconnectServer();
        expect(resetPresence.length).toBeGreaterThan(0);
        expect(resetPresence.every(active => active === false)).toBe(true);
        expect(storage.getState().machines).toEqual({});
        expect(storage.getState().machineDisplayById).toEqual({});
        expect(observed).toEqual([false]);
        expect(readMachineActivity(held).active).toBe(false);
    } finally {
        stopStore();
        stopActivity();
        await connection.dispose();
    }
});
