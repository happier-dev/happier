import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';

import { useAwaitedMachineArrival } from './useAwaitedMachineArrival';

afterEach(() => {
    standardCleanup();
});

function seedMachines(...machines: Parameters<typeof createMachineFixture>[0][]) {
    const state = storage.getState();
    state.applyMachines(
        machines.map((machine) => createMachineFixture(machine)),
        true,
    );
}

async function applyMachine(machine: Parameters<typeof createMachineFixture>[0], serverId?: string) {
    await act(async () => {
        storage.getState().applyMachines([createMachineFixture(machine)], false, serverId ? { sourceServerId: serverId } : undefined);
    });
}

describe('useAwaitedMachineArrival', () => {
    it('stays waiting when a socket reconnect replays a machine already online in the snapshot', async () => {
        const previousState = storage.getState();
        const now = Date.now();
        try {
            seedMachines({ id: 'm-existing', active: true, activeAt: now, updatedAt: now });

            const hook = await renderHook(() => useAwaitedMachineArrival(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            await applyMachine({ id: 'm-existing', active: true, activeAt: now + 500, updatedAt: now + 500 });

            expect(hook.getCurrent()).toMatchObject({ status: 'waiting', machine: undefined, isOnline: false });
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('arrives when a snapshot machine transitions from offline to online', async () => {
        const previousState = storage.getState();
        const staleAt = Date.now() - 10 * 60_000;
        const freshAt = Date.now();
        try {
            seedMachines({ id: 'm-returning', active: true, activeAt: staleAt, updatedAt: staleAt });

            const hook = await renderHook(() => useAwaitedMachineArrival(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            await applyMachine({ id: 'm-returning', active: true, activeAt: freshAt, updatedAt: freshAt });

            expect(hook.getCurrent().status).toBe('arrived');
            expect(hook.getCurrent().machine?.id).toBe('m-returning');
            expect(hook.getCurrent().isOnline).toBe(true);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('chooses the most recently active online machine when multiple machines arrive', async () => {
        const previousState = storage.getState();
        const now = Date.now();
        try {
            seedMachines();

            const hook = await renderHook(() => useAwaitedMachineArrival(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            await act(async () => {
                storage.getState().applyMachines([
                    createMachineFixture({ id: 'm-older', active: true, activeAt: now + 1000, updatedAt: now + 1000 }),
                    createMachineFixture({ id: 'm-newer', active: true, activeAt: now + 3000, updatedAt: now + 3000 }),
                ]);
            });

            expect(hook.getCurrent().status).toBe('arrived');
            expect(hook.getCurrent().machine?.id).toBe('m-newer');
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('resets the snapshot when serverUrl changes', async () => {
        const previousState = storage.getState();
        const now = Date.now();
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {},
                machineListByServerId: {
                    'https://one.example.test': [createMachineFixture({ id: 'm-one', active: true, activeAt: now, updatedAt: now })],
                    'https://two.example.test': [],
                },
            }));

            const hook = await renderHook(
                ({ serverUrl }: { serverUrl: string }) => useAwaitedMachineArrival({ serverUrl }),
                {
                    initialProps: { serverUrl: 'https://one.example.test' },
                    flushOptions: { cycles: 1, turns: 4 },
                },
            );

            expect(hook.getCurrent().status).toBe('waiting');

            await hook.rerender({ serverUrl: 'https://two.example.test' });
            await applyMachine(
                { id: 'm-two', active: true, activeAt: now + 1000, updatedAt: now + 1000 },
                'https://two.example.test',
            );

            expect(hook.getCurrent().status).toBe('arrived');
            expect(hook.getCurrent().machine?.id).toBe('m-two');
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('can recover an arrival after remount when since predates the machine heartbeat', async () => {
        const previousState = storage.getState();
        const since = Date.now();
        const activeAt = since + 1000;
        try {
            seedMachines({ id: 'm-arrived-before-remount', active: true, activeAt, updatedAt: activeAt });

            const hook = await renderHook(() => useAwaitedMachineArrival({ since }), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().status).toBe('arrived');
            expect(hook.getCurrent().machine?.id).toBe('m-arrived-before-remount');
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('stays waiting without machines or an authenticated socket feed', async () => {
        const previousState = storage.getState();
        try {
            seedMachines();

            const hook = await renderHook(() => useAwaitedMachineArrival(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({ status: 'waiting', machine: undefined, isOnline: false });
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
