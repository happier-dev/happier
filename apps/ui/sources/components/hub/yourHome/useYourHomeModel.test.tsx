import { act } from 'react-test-renderer';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded, withdrawMachinePresenceForScope, captureMachinePresenceObservation } = await import('@/sync/domains/machines/reachability/machineReachability');
const { useYourHomeModel } = await import('./useYourHomeModel');
const before = storage.getState();

afterEach(() => {
    standardCleanup();
    storage.setState(before, true);
    clearMachineRequestReachabilityForTest();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    network.resetRequests();
});
afterAll(() => network.dispose());

describe('Your Home machine reachability', () => {
    it('keeps withdrawn Machine presence unknown and restores only its exact Home and Account', async () => {
        const home = await network.addHome('https://your-home-withdrawal.test', 'account-home');
        setActiveServerId(home.id);
        const machine = createMachineFixture({ id: 'studio', activeAt: Date.now() });
        const scope = { serverId: home.id, accountId: 'account-home' };
        storage.setState(state => ({ profileScope: scope, profile: { ...state.profile, id: scope.accountId },
            machines: { [machine.id]: machine }, machineListByServerId: { [home.id]: [machine] } }));
        const hook = await renderHook(() => useYourHomeModel());
        await act(async () => withdrawMachinePresenceForScope(scope));
        expect(hook.getCurrent()).toMatchObject({ online: 0, machines: [{ id: machine.id, online: null, lastSeenAt: null }] });
        await act(async () => captureMachinePresenceObservation({ ...scope, accountId: 'another-account' })([machine.id]));
        expect(hook.getCurrent().machines[0]?.online).toBeNull();
        await act(async () => captureMachinePresenceObservation(scope)([machine.id]));
        expect(hook.getCurrent().machines[0]?.online).toBe(true);
        await hook.unmount();
    });

    it('refreshes failed requests and recovery on the exact Home while retaining the machine row', async () => {
        const home = await network.addHome('https://your-home-reachability.test', 'account-home');
        setActiveServerId(home.id);
        const machine = createMachineFixture({ id: 'studio', activeAt: Date.now() });
        const scope = { serverId: home.id, accountId: 'account-home' };
        storage.setState(state => ({ profileScope: scope, profile: { ...state.profile, id: scope.accountId },
            machines: { [machine.id]: machine }, machineListByServerId: { [home.id]: [machine] } }));
        const hook = await renderHook(() => useYourHomeModel());
        expect(hook.getCurrent()).toMatchObject({ online: 1, machines: [{ id: machine.id, online: true }] });
        await act(async () => recordMachineRequestFailed({ serverId: 'other-home', accountId: scope.accountId, machineId: machine.id }));
        expect(hook.getCurrent().online).toBe(1);
        await act(async () => recordMachineRequestFailed({ ...scope, machineId: machine.id }));
        expect(hook.getCurrent()).toMatchObject({ online: 0, machines: [{ id: machine.id, online: false, lastSeenAt: null }] });
        await act(async () => recordMachineRequestSucceeded({ ...scope, machineId: machine.id }));
        expect(hook.getCurrent()).toMatchObject({ online: 1, machines: [{ id: machine.id, online: true, lastSeenAt: null }] });
        expect(network.requests).toEqual([]);
        await hook.unmount();
    });

    it('keeps machine presence active until the server publishes an offline observation', async () => {
        const home = await network.addHome('https://your-home-presence.test', 'account-home');
        setActiveServerId(home.id);
        vi.useFakeTimers();
        const now = Date.now();
        vi.setSystemTime(now);
        const machine = createMachineFixture({ id: 'studio', activeAt: now - 59_500, presenceProtocolVersion: 1 });
        storage.setState({ profileScope: { serverId: home.id, accountId: 'account-home' }, machines: { [machine.id]: machine }, machineListByServerId: { [home.id]: [machine] } });
        const hook = await renderHook(() => useYourHomeModel());
        expect(hook.getCurrent().online).toBe(1);
        await act(async () => { await vi.advanceTimersByTimeAsync(501); });
        expect(hook.getCurrent().online).toBe(1);
        await act(async () => storage.getState().applyMachineActivityUpdates([{ id: machine.id, active: false, activeAt: now }], { sourceServerId: home.id }));
        expect(hook.getCurrent()).toMatchObject({ online: 0, machines: [{ id: machine.id, online: false }] });
        expect(network.requests).toEqual([]);
        await hook.unmount();
    });
});
