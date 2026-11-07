import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storageStore';
import { removeServerProfile, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { beginMachineAddWatch } from '@/components/machines/add/machineAddTaskLifetime';
import { discardMachineAddFlowDraft, readMachineAddFlowDraft } from '@/components/machines/add/machineAddFlowStore';

import { createAwaitedMachineArrivalBaseline, useAwaitedMachineArrival, type AwaitedMachineArrivalBaseline } from './useAwaitedMachineArrival';

// Native navigation is an external boundary; this test only consumes the real machine feed.
vi.mock('expo-router/build/link/href', () => ({ resolveHref: vi.fn() }));
vi.mock('@/config', () => ({ config: { variant: 'production', identityVariant: 'stable' } }));
// Canonical UI presentation boundaries; internal task/feed/arrival decisions remain real.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

afterEach(() => {
    vi.restoreAllMocks();
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
    it('accepts a fresh supplied baseline for a second wait on the same Home and ignores revoked arrivals', async () => {
        const previousState = storage.getState();
        try {
            seedMachines();
            const initialProps: { baseline: AwaitedMachineArrivalBaseline | null } = { baseline: null };
            const hook = await renderHook(({ baseline }: typeof initialProps) => useAwaitedMachineArrival({ baseline }), { initialProps });
            await applyMachine({ id: 'first', activeAt: Date.now() });
            expect(hook.getCurrent().machine?.id).toBe('first');
            await hook.rerender({ baseline: createAwaitedMachineArrivalBaseline('', Object.values(storage.getState().machines)) });
            expect(hook.getCurrent().status).toBe('waiting');
            await applyMachine({ id: 'revoked', activeAt: Date.now(), revokedAt: Date.now() });
            expect(hook.getCurrent().status).toBe('waiting');
            await hook.unmount();
        } finally { storage.setState(previousState); }
    });
    it('never substitutes the active Home list for an explicitly named Home that is still loading', async () => {
        const previousState = storage.getState();
        const home = await upsertServerProfile({ serverUrl: 'https://loading.example.test', name: 'Loading' });
        try {
            seedMachines({ id: 'other-home', activeAt: Date.now() });
            storage.setState({ machineListByServerId: {} });
            let baseline: AwaitedMachineArrivalBaseline | null = null;
            const hook = await renderHook(() => useAwaitedMachineArrival({
                serverId: home.id, serverUrl: home.serverUrl,
                onBaselineCaptured: (next) => { baseline = next; },
            }));
            expect(baseline).toBeNull();
            await act(async () => storage.setState({ machineListByServerId: {
                [home.id]: [createMachineFixture({ id: 'already-there', activeAt: Date.now() })],
            } }));
            expect(hook.getCurrent().status).toBe('waiting');
            await act(async () => storage.setState({ machineListByServerId: {
                [home.id]: [createMachineFixture({ id: 'new-here', activeAt: Date.now() })],
            } }));
            expect(hook.getCurrent().machine?.id).toBe('new-here');
            await hook.unmount();
        } finally {
            storage.setState(previousState);
            await removeServerProfile(home.id);
        }
    });
    it('starts a fresh baseline only when an enabled watch begins', async () => {
        const previousState = storage.getState();
        try {
            seedMachines();
            const hook = await renderHook(({ enabled }: { enabled: boolean }) => useAwaitedMachineArrival({ enabled }), { initialProps: { enabled: false } });
            await applyMachine({ id: 'before-watch', activeAt: Date.now() });
            await hook.rerender({ enabled: true });
            expect(hook.getCurrent().status).toBe('waiting');
            await applyMachine({ id: 'after-watch', activeAt: Date.now() });
            expect(hook.getCurrent().machine?.id).toBe('after-watch');
            await hook.rerender({ enabled: false });
            expect(hook.getCurrent().status).toBe('waiting');
            await hook.unmount();
        } finally { storage.setState(previousState); }
    });
    it('does no arrival rendering or baseline publication for Machine changes until a watch is enabled', async () => {
        const previousState = storage.getState();
        try {
            seedMachines();
            let renders = 0;
            const onBaselineCaptured = vi.fn();
            const hook = await renderHook(({ enabled }: { enabled: boolean }) => {
                renders += 1;
                return useAwaitedMachineArrival({ enabled, onBaselineCaptured });
            }, { initialProps: { enabled: false } });
            const initialRenders = renders;
            const waiting = hook.getCurrent();
            for (let index = 0; index < 5; index += 1) {
                await applyMachine({ id: `before-watch-${index}`, activeAt: Date.now() });
            }
            expect(renders - initialRenders).toBe(0);
            expect(onBaselineCaptured).not.toHaveBeenCalled();
            expect(hook.getCurrent()).toBe(waiting);

            await hook.rerender({ enabled: true });
            expect(hook.getCurrent().status).toBe('waiting');
            expect(onBaselineCaptured).toHaveBeenCalledTimes(1);
            await applyMachine({ id: 'after-watch', activeAt: Date.now() });
            expect(hook.getCurrent().machine?.id).toBe('after-watch');
            expect(renders).toBeGreaterThan(initialRenders);
            await hook.unmount();
        } finally { storage.setState(previousState); }
    });
    it('stays waiting when a socket reconnect replays a machine already online in the snapshot', async () => {
        const previousState = storage.getState();
        const now = Date.now();
        try {
            seedMachines({ id: 'm-existing', active: true, activeAt: now, updatedAt: now });

            const hook = await renderHook(() => useAwaitedMachineArrival(), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const waiting = hook.getCurrent();

            await applyMachine({ id: 'm-existing', active: true, activeAt: now + 500, updatedAt: now + 500 });

            expect(hook.getCurrent()).toBe(waiting);
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
            const machines = storage.getState().machines;

            await applyMachine({ id: 'm-returning', active: true, activeAt: freshAt, updatedAt: freshAt });

            // Recovery publishes presence while retaining the content inventory.
            expect(storage.getState().machines).toBe(machines);
            expect(machines['m-returning']?.activeAt).toBe(staleAt);
            expect(storage.getState().machines['m-returning']?.metadata).toBe(machines['m-returning']?.metadata);
            expect(hook.getCurrent().status).toBe('arrived');
            expect(hook.getCurrent().machine?.id).toBe('m-returning');
            expect(hook.getCurrent().isOnline).toBe(true);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('observes presence recovery only for the named Home without replacing the other Home inventory', async () => {
        const previousState = storage.getState();
        const one = await upsertServerProfile({ serverUrl: 'https://arrival-one.example.test', name: 'Arrival one' });
        const two = await upsertServerProfile({ serverUrl: 'https://arrival-two.example.test', name: 'Arrival two' });
        const staleAt = Date.now() - 10 * 60_000;
        try {
            storage.getState().applyMachines([createMachineFixture({ id: 'shared-id', activeAt: staleAt, updatedAt: staleAt })], true, { sourceServerId: one.id });
            storage.getState().applyMachines([createMachineFixture({ id: 'shared-id', activeAt: staleAt, updatedAt: staleAt })], true, { sourceServerId: two.id });
            const hook = await renderHook(() => useAwaitedMachineArrival({ serverId: one.id, serverUrl: one.serverUrl }));
            const waiting = hook.getCurrent();
            const inventory = storage.getState().machineListByServerId[one.id];

            await applyMachine({ id: 'shared-id', activeAt: Date.now(), updatedAt: Date.now() }, two.id);
            expect(hook.getCurrent()).toBe(waiting);
            expect(storage.getState().machineListByServerId[one.id]).toBe(inventory);
            const otherInventory = storage.getState().machineListByServerId[two.id];
            await applyMachine({ id: 'shared-id', activeAt: Date.now(), updatedAt: Date.now() }, one.id);

            expect(storage.getState().machineListByServerId[one.id]).toBe(inventory);
            expect(storage.getState().machineListByServerId[two.id]).toBe(otherInventory);
            expect(inventory?.[0]?.activeAt).toBe(staleAt);
            expect(storage.getState().machineListByServerId[one.id]?.[0]?.metadata).toBe(inventory?.[0]?.metadata);
            expect(hook.getCurrent()).toMatchObject({ status: 'arrived', machine: { id: 'shared-id' }, isOnline: true });
            await hook.unmount();
        } finally {
            storage.setState(previousState);
            await removeServerProfile(one.id);
            await removeServerProfile(two.id);
        }
    });

    it.each([
        { capture: 'implicit', recovery: 'inventory-and-presence' },
        { capture: 'implicit', recovery: 'presence-only' },
        { capture: 'retained', recovery: 'presence-only' },
    ] as const)('keeps a $capture wait pending when $recovery recovered before it began', async ({ capture, recovery }) => {
        const previousState = storage.getState();
        const home = await upsertServerProfile({ serverUrl: 'https://arrival-recovered.example', name: 'Recovered' });
        const staleAt = Date.now() - 10 * 60_000;
        try {
            storage.getState().applyMachines([
                createMachineFixture({ id: 'already-recovered', activeAt: staleAt, updatedAt: staleAt }),
            ], true, { sourceServerId: home.id });
            const inventory = storage.getState().machineListByServerId[home.id];

            if (recovery === 'inventory-and-presence') {
                await applyMachine({ id: 'already-recovered', activeAt: Date.now(), updatedAt: Date.now() }, home.id);
            } else {
                // The hook's scoped inputs may carry newer presence than retained inventory.
                // Seed that input contract without replacing the real store or its readers.
                await act(async () => storage.setState((state) => ({
                    machinePresenceByServerId: {
                        ...state.machinePresenceByServerId,
                        [home.id]: { 'already-recovered': { active: true, activeAt: Date.now(), updatedAt: Date.now() } },
                    },
                })));
            }
            if (recovery === 'inventory-and-presence') {
                expect(storage.getState().machineListByServerId[home.id]).toBe(inventory);
                expect(inventory?.[0]?.activeAt).toBe(staleAt);
            } else {
                expect(storage.getState().machineListByServerId[home.id]).toBe(inventory);
            }

            if (capture === 'retained') beginMachineAddWatch(home.id, 'ssh');
            let baseline: AwaitedMachineArrivalBaseline | null = capture === 'retained' ? readMachineAddFlowDraft().baseline : null;
            const onBaselineCaptured = (next: AwaitedMachineArrivalBaseline) => { baseline = next; };
            const first = await renderHook(() => useAwaitedMachineArrival({
                serverId: home.id, serverUrl: home.serverUrl, baseline, onBaselineCaptured,
            }));
            expect(first.getCurrent()).toMatchObject({ status: 'waiting', machine: undefined, isOnline: false });
            await first.unmount();

            await applyMachine({ id: 'arrived-while-unmounted', activeAt: Date.now(), updatedAt: Date.now() }, home.id);
            const remounted = await renderHook(() => useAwaitedMachineArrival({
                serverId: home.id, serverUrl: home.serverUrl, baseline, onBaselineCaptured,
            }));
            expect(remounted.getCurrent()).toMatchObject({ status: 'arrived', machine: { id: 'arrived-while-unmounted' }, isOnline: true });
            await remounted.unmount();
        } finally {
            discardMachineAddFlowDraft();
            storage.setState(previousState);
            await removeServerProfile(home.id);
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

    it('watches the machine list of the server it was given by URL, keyed by that server profile', async () => {
        const previousState = storage.getState();
        const now = Date.now();
        const one = await upsertServerProfile({ serverUrl: 'https://one.example.test', name: 'One' });
        const two = await upsertServerProfile({ serverUrl: 'https://two.example.test', name: 'Two' });
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {},
                machineListByServerId: {
                    [one.id]: [createMachineFixture({ id: 'm-one', active: true, activeAt: now, updatedAt: now })],
                    [two.id]: [],
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
                two.id,
            );

            expect(hook.getCurrent().status).toBe('arrived');
            expect(hook.getCurrent().machine?.id).toBe('m-two');
            await hook.unmount();
        } finally {
            storage.setState(previousState);
            await removeServerProfile(one.id);
            await removeServerProfile(two.id);
        }
    });

    it('recovers an arrival after remount from the wait baseline, whatever the client clock says', async () => {
        const previousState = storage.getState();
        // Server-stamped registration times far behind a skewed-ahead client clock.
        const clientNow = Date.now() + 24 * 60 * 60_000;
        vi.spyOn(Date, 'now').mockReturnValue(clientNow);
        try {
            seedMachines({ id: 'm-existing', active: true, createdAt: 1_000, activeAt: clientNow, updatedAt: clientNow });

            let baseline: AwaitedMachineArrivalBaseline | null = null;
            const onBaselineCaptured = (next: AwaitedMachineArrivalBaseline) => {
                baseline = next;
            };
            const first = await renderHook(() => useAwaitedMachineArrival({ onBaselineCaptured }), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            expect(first.getCurrent().status).toBe('waiting');
            await first.unmount();

            // The awaited computer registers while the card is unmounted.
            await applyMachine({ id: 'm-arrived-while-unmounted', active: true, createdAt: 2_000, activeAt: clientNow, updatedAt: clientNow });

            const remounted = await renderHook(() => useAwaitedMachineArrival({ baseline, onBaselineCaptured }), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(remounted.getCurrent().status).toBe('arrived');
            expect(remounted.getCurrent().machine?.id).toBe('m-arrived-while-unmounted');
            await remounted.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('never counts a computer already in the wait baseline, even when its registration time is ahead of the client clock', async () => {
        const previousState = storage.getState();
        // Server-stamped registration time far ahead of a skewed-behind client clock.
        const clientNow = Date.now();
        const serverRegisteredAt = clientNow + 60 * 60_000;
        try {
            seedMachines({ id: 'm-other-computer', active: true, createdAt: serverRegisteredAt, activeAt: serverRegisteredAt, updatedAt: serverRegisteredAt });

            let baseline: AwaitedMachineArrivalBaseline | null = null;
            const onBaselineCaptured = (next: AwaitedMachineArrivalBaseline) => {
                baseline = next;
            };
            const first = await renderHook(() => useAwaitedMachineArrival({ onBaselineCaptured }), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            expect(first.getCurrent().status).toBe('waiting');
            await first.unmount();

            await applyMachine({ id: 'm-other-computer', active: true, createdAt: serverRegisteredAt, activeAt: serverRegisteredAt + 5_000, updatedAt: serverRegisteredAt + 5_000 });

            const remounted = await renderHook(() => useAwaitedMachineArrival({ baseline, onBaselineCaptured }), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(baseline).not.toBeNull();
            expect(remounted.getCurrent()).toMatchObject({ status: 'waiting', machine: undefined, isOnline: false });
            await remounted.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not count an already-online computer that only appears once the machine list loads', async () => {
        const previousState = storage.getState();
        const now = Date.now();
        try {
            storage.setState((state) => ({ ...state, isDataReady: true, machines: {}, machineListByServerId: {} }));

            const hook = await renderHook(() => useAwaitedMachineArrival(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            await act(async () => {
                storage.getState().applyMachines([
                    createMachineFixture({ id: 'm-loaded-late', active: true, createdAt: now + 60 * 60_000, activeAt: now + 1000, updatedAt: now + 1000 }),
                ], true);
            });

            expect(hook.getCurrent()).toMatchObject({ status: 'waiting', machine: undefined, isOnline: false });
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
