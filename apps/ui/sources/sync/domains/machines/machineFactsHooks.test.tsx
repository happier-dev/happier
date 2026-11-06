import { act } from 'react-test-renderer';
import { beforeEach, expect, it } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useActiveMachineFacts, useLaunchSelectionMachines, useMachineListByServerId, useMachineListForServer, useMachineRecordListsByServerId } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { readMachineActivity } from '@/sync/domains/machines/machineActivity';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { selectActiveTestHomeForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';

beforeEach(async () => { await selectActiveTestHomeForTests(); });

it('shares inventory projection work and visits no rows for unchanged input publications', async () => {
    const store = getStorage();
    const previous = store.getState();
    const serverId = getActiveServerSnapshot().serverId;
    const options = { sourceServerId: serverId };
    const rows = Array.from({ length: 196 }, (_, index) => createMachineFixture({ id: `projection-${index}`, activeAt: Date.now() }));
    store.getState().applyMachines(rows, true, options);
    let visits = 0;
    // Observe real inventory traversal, independent of the projection's function/file names.
    const inventory = store.getState().machineListByServerId[serverId]!;
    const records = store.getState().machines;
    for (let index = 0; index < inventory.length; index++) {
        const row = inventory[index]!;
        Object.defineProperty(inventory, index, { configurable: true, get: () => { visits++; return row; } });
        Object.defineProperty(records, row.id, { configurable: true, get: () => { visits++; return row; } });
    }
    const first = await renderHook(() => useMachineListByServerId());
    const firstActive = await renderHook(() => useActiveMachineFacts());
    const firstLaunch = await renderHook(() => useLaunchSelectionMachines());
    const projected = first.getCurrent()[serverId];
    visits = 0;
    const second = await renderHook(() => useMachineListByServerId());
    const addressed = await renderHook(() => useMachineListForServer(serverId));
    const secondActive = await renderHook(() => useActiveMachineFacts());
    const secondLaunch = await renderHook(() => useLaunchSelectionMachines());
    try {
        expect(visits).toBe(0);
        expect(second.getCurrent()[serverId]).toBe(projected);
        expect(addressed.getCurrent()).toBe(projected);
        expect(secondActive.getCurrent()).toBe(firstActive.getCurrent());
        expect(secondLaunch.getCurrent()).toBe(firstLaunch.getCurrent());
        for (let publication = 0; publication < 3; publication++) {
            await act(async () => store.setState({ machineListByServerId: { ...store.getState().machineListByServerId } }));
        }
        expect(visits).toBe(0);
        await act(async () => store.getState().applyMachines([{ ...rows[0]!, metadataVersion: 2,
            metadata: { ...rows[0]!.metadata!, displayName: 'Changed fact' } }], false, options));
        expect(first.getCurrent()[serverId]?.[0]?.metadata?.displayName).toBe('Changed fact');
        expect(second.getCurrent()[serverId]).toBe(first.getCurrent()[serverId]);
        expect(addressed.getCurrent()).toBe(first.getCurrent()[serverId]);
        expect(secondActive.getCurrent().find(row => row.id === rows[0]!.id)?.metadata?.displayName).toBe('Changed fact');
        expect(secondLaunch.getCurrent().find(row => row.id === rows[0]!.id)?.metadata?.displayName).toBe('Changed fact');
        expect(visits).toBeGreaterThan(0);
    } finally {
        await first.unmount(); await second.unmount(); await addressed.unmount();
        await firstActive.unmount(); await secondActive.unmount();
        await firstLaunch.unmount(); await secondLaunch.unmount();
        store.setState(previous);
    }
});

// Every Machine list reader has facts semantics: quiet for the daemon resource channel, live for real changes, and
// a held row keeps observing the current row's presence clock. Readers of the live daemon version or resources use
// the explicitly raw record hook, which still sees every publication (the stale-field case).
it('keeps every list reader quiet for resource publications and live for facts and presence', async () => {
    const store = getStorage();
    const previous = store.getState();
    // An addressed Home: its inventory is the server-scoped list, whichever Home is active.
    const serverId = 'machine-facts-home';
    const options = { sourceServerId: serverId };
    const daemonState = { status: 'running', pid: 1, startedAt: 1, contributionRegistryProjectionRevision: 1 } as Machine['daemonState'];
    let busy: Machine = createMachineFixture({ id: 'facts-busy', active: true, activeAt: Date.now(), daemonState, daemonStateVersion: 1 });
    store.getState().applyMachines([busy], true, options);
    const renders = { server: 0, lists: 0, raw: 0 };
    const server = await renderHook(() => { renders.server += 1; return useMachineListForServer(serverId); });
    const lists = await renderHook(() => { renders.lists += 1; return useMachineListByServerId(); });
    const raw = await renderHook(() => { renders.raw += 1; return useMachineRecordListsByServerId(); });
    const rows = () => [server.getCurrent() ?? [], lists.getCurrent()[serverId] ?? []]
        .map(list => list.find(machine => machine.id === busy.id));
    try {
        expect(rows().every(Boolean)).toBe(true);
        renders.server = 0; renders.lists = 0; renders.raw = 0;
        for (let sample = 1; sample <= 3; sample++) {
            busy = { ...busy, daemonStateVersion: (busy.daemonStateVersion ?? 0) + 1,
                daemonState: { ...(busy.daemonState ?? {}), resources: { v: 1, sampledAt: sample } } as Machine['daemonState'] };
            await act(async () => store.getState().applyMachines([busy], false, options));
        }
        expect({ ...renders, raw: renders.raw > 0 }).toEqual({ server: 0, lists: 0, raw: true });
        expect(raw.getCurrent()[serverId]?.find(machine => machine.id === busy.id)?.daemonStateVersion).toBe(busy.daemonStateVersion);
        const heartbeatAt = Date.now() + 5_000;
        await act(async () => store.getState().applyMachineActivityUpdates([{ id: busy.id, active: true, activeAt: heartbeatAt }], options));
        for (const held of rows()) expect(readMachineActivity(held!).activeAt).toBe(heartbeatAt);
        await act(async () => store.getState().applyMachines([{ ...busy, metadataVersion: busy.metadataVersion + 1,
            metadata: { ...busy.metadata!, displayName: 'Renamed' } }], false, options));
        expect(rows().map(row => row?.metadata?.displayName)).toEqual(['Renamed', 'Renamed']);
    } finally {
        await server.unmount(); await lists.unmount(); await raw.unmount();
        store.setState(previous);
    }
});

// A hidden retained surface parks its machine inventory: Machine publications while hidden render nothing,
// and presenting it again reads the current inventory (no stale view).
it.each(['active', 'addressed'] as const)('parks the %s machine fact list while its surface is not presented and catches up on reveal', async reader => {
    const store = getStorage();
    const previous = store.getState();
    const serverId = reader === 'active' ? getActiveServerSnapshot().serverId : 'machine-facts-parked-home';
    const options = { sourceServerId: serverId };
    let machine: Machine = createMachineFixture({ id: `parked-${reader}`, active: true, activeAt: Date.now() });
    store.getState().applyMachines([machine], true, options);
    let renders = 0;
    const hook = await renderHook((presented: boolean) => {
        renders += 1;
        return reader === 'active' ? useActiveMachineFacts(true, presented) : useMachineListForServer(serverId, true, presented);
    }, { initialProps: true });
    const read = () => hook.getCurrent()?.find(row => row.id === machine.id);
    try {
        await hook.rerender(false);
        renders = 0;
        for (let index = 1; index <= 3; index++) {
            machine = { ...machine, metadataVersion: machine.metadataVersion + 1, metadata: { ...machine.metadata!, displayName: `Renamed ${index}` } };
            await act(async () => store.getState().applyMachines([machine], false, options));
            await act(async () => store.getState().applyMachineActivityUpdates([{ id: machine.id, active: true, activeAt: Date.now() + index * 1_000 }], options));
        }
        expect(renders).toBe(0);
        await hook.rerender(true);
        expect(read()?.metadata?.displayName).toBe('Renamed 3');
    } finally {
        await hook.unmount();
        store.setState(previous);
    }
});
