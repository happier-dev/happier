import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createMachineFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { captureMachinePresenceObservation, clearMachineRequestReachabilityForTest, withdrawMachinePresenceForScope } from '@/sync/domains/machines/reachability/machineReachability';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { useActiveHomeConnectionHealth, useConnectionHealth } = await import('./useConnectionHealth');
const { useActiveHomeUnavailable } = await import('./HomeReachabilityGate');
const initialStorageState = storage.getState();
let appliedHomeId = '';
let stagedHomeId = '';

beforeEach(async () => {
    await homes.reset();
    appliedHomeId = await homes.addHome({ name: 'Applied Home', serverUrl: 'https://health-applied.test', accountId: 'health-account' });
    stagedHomeId = await homes.addHome({ name: 'Staged Home', serverUrl: 'https://health-staged.test', accountId: 'staged-account', active: false });
    storage.getState().activateProfileScope({ serverId: appliedHomeId, accountId: 'health-account' });
    storage.setState({ machineListByServerId: { [appliedHomeId]: [] }, machineListStatusByServerId: { [appliedHomeId]: 'loading' },
        socketStatus: 'connected', endpointStatus: 'online', endpointReason: null, syncError: null });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
});
afterEach(async () => {
    standardCleanup();
    await homes.reset();
    publishAppliedActiveServerRuntimeAvailability(false);
    storage.setState(initialStorageState, true);
    clearMachineRequestReachabilityForTest();
});

function applyMachine(serverId: string, id: string, host: string, presence = { active: true, activeAt: Date.now() }) {
    storage.getState().applyMachines([createMachineFixture({ id, ...presence, metadata: { ...createMachineFixture().metadata!, host } })], true,
        { sourceServerId: serverId, sourceAccountId: serverId === appliedHomeId ? 'health-account' : 'staged-account' });
    storage.getState().markMachineListSettled(serverId);
}

describe('useActiveHomeConnectionHealth', () => {
    it('pushes recovered Home health to chrome and the unavailable reader despite a retained sync failure', async () => {
        applyMachine(appliedHomeId, 'machine-a', 'applied-a');
        storage.setState({ endpointStatus: 'offline', socketStatus: 'disconnected', syncError: {
            kind: 'unknown', message: 'A background read failed', retryable: true, at: Date.now(), serverId: appliedHomeId,
        } });
        const hook = await renderHook(() => ({ health: useActiveHomeConnectionHealth(), unavailable: useActiveHomeUnavailable() }));
        expect(hook.getCurrent().unavailable).toBe(true);
        await act(async () => { storage.setState({ endpointStatus: 'online', socketStatus: 'connected' }); });
        expect(hook.getCurrent().health.kind).toBe('healthy');
        expect(hook.getCurrent().unavailable).toBe(false);
        expect(storage.getState().syncError).not.toBeNull();
    });

    it('counts the same current persistent fleet in Account chrome and selected-Home health', async () => {
        storage.getState().applyMachines([
            createMachineFixture({ id: 'online', active: true, activeAt: 0 }),
            createMachineFixture({ id: 'offline', active: false, activeAt: 0 }),
            createMachineFixture({ id: 'previous', active: false, activeAt: 0, replacedByMachineId: 'online' }),
        ], true, { sourceServerId: appliedHomeId, sourceAccountId: 'health-account' });
        storage.getState().markMachineListSettled(appliedHomeId);
        const hook = await renderHook(() => ({ active: useActiveHomeConnectionHealth(), selected: useConnectionHealth() }));
        expect(hook.getCurrent().active).toMatchObject({ machineCount: 2, onlineCount: 1 });
        expect(hook.getCurrent().selected).toMatchObject({ machineCount: 2, onlineCount: 1 });
        expect(storage.getState().machineListByServerId[appliedHomeId]).toHaveLength(3);
    });

    it('withdraws retained chrome presence without reporting offline and restores fresh offline truth', async () => {
        applyMachine(appliedHomeId, 'machine-a', 'applied-a', { active: false, activeAt: 1 });
        const hook = await renderHook(useActiveHomeConnectionHealth);
        expect(hook.getCurrent().kind).toBe('machine_offline');
        const scope = { serverId: appliedHomeId, accountId: 'health-account' };
        await act(async () => withdrawMachinePresenceForScope(scope));
        expect(hook.getCurrent()).toMatchObject({ kind: 'machine_unknown', machineCount: 1, onlineCount: 0,
            hasUnknownMachines: true, machineLabelKey: 'status.unknown' });
        await act(async () => captureMachinePresenceObservation(scope)(['machine-a']));
        expect(hook.getCurrent()).toMatchObject({ kind: 'machine_offline', onlineCount: 0,
            hasUnknownMachines: false, machineLabelKey: 'status.offline' });
    });

    it('keeps unavailable-only readers quiet across Machine metadata publications while observing real Home failures', async () => {
        applyMachine(appliedHomeId, 'machine-a', 'applied-a');
        let renders = 0;
        const hook = await renderHook(() => { renders++; return useActiveHomeUnavailable(); });
        expect(hook.getCurrent()).toBe(false);
        const settledRenders = renders;
        await act(async () => { applyMachine(appliedHomeId, 'machine-a', 'renamed-a'); });
        expect(hook.getCurrent()).toBe(false);
        expect(renders).toBe(settledRenders);
        await act(async () => { storage.setState({ endpointStatus: 'offline', socketStatus: 'disconnected' }); });
        expect(hook.getCurrent()).toBe(true);
        await act(async () => { publishAppliedActiveServerRuntimeAvailability(false); });
        expect(hook.getCurrent()).toBe(false);
        await act(async () => { publishAppliedActiveServerRuntimeAvailability(true); });
        expect(hook.getCurrent()).toBe(true);
        await act(async () => { storage.setState({ endpointStatus: 'online', socketStatus: 'connected' }); });
        expect(hook.getCurrent()).toBe(false);
    });

    it('keeps an empty active Home machine list unknown while it is loading', async () => {
        const hook = await renderHook(useActiveHomeConnectionHealth);
        expect(hook.getCurrent()).toMatchObject({ kind: 'connecting', machineCount: 0, onlineCount: 0,
            hasUnknownMachines: true, machineLabelKey: 'status.unknown' });
    });

    it('keeps chrome health on the applied Home while another Home is staged', async () => {
        applyMachine(appliedHomeId, 'machine-a', 'applied-a');
        await setActiveServerId(stagedHomeId);
        storage.getState().setSyncError({ serverId: stagedHomeId, kind: 'auth', message: 'Staged Home auth error', retryable: false, at: Date.now() });
        const hook = await renderHook(useActiveHomeConnectionHealth);
        expect(hook.getCurrent()).toMatchObject({ kind: 'healthy', machineCount: 1, onlineCount: 1,
            primaryMachineLabel: 'applied-a', machineLabelKey: 'status.online' });

        const appliedHealth = hook.getCurrent();
        await act(async () => { applyMachine(stagedHomeId, 'machine-b', 'staged-b'); });
        expect(hook.getCurrent()).toBe(appliedHealth);
    });

    it('does not present staged Home transport health under the applied Home label', async () => {
        applyMachine(appliedHomeId, 'machine-a', 'applied-a');
        await setActiveServerId(stagedHomeId);
        publishAppliedActiveServerRuntimeAvailability(false);
        const hook = await renderHook(useActiveHomeConnectionHealth);
        expect(hook.getCurrent()).toMatchObject({ kind: 'connecting', endpointStatus: 'connecting', primaryMachineLabel: 'applied-a' });
    });

    it('keeps the applied Home connecting when its canonical runtime is unavailable', async () => {
        applyMachine(appliedHomeId, 'machine-a', 'applied-a');
        publishAppliedActiveServerRuntimeAvailability(false);
        const hook = await renderHook(useActiveHomeConnectionHealth);
        expect(hook.getCurrent()).toMatchObject({ kind: 'connecting', endpointStatus: 'connecting', primaryMachineLabel: 'applied-a' });
    });

    it('recovers same-target health when the applied runtime becomes available', async () => {
        applyMachine(appliedHomeId, 'machine-a', 'applied-a');
        publishAppliedActiveServerRuntimeAvailability(false);
        const hook = await renderHook(useActiveHomeConnectionHealth);
        expect(hook.getCurrent()).toMatchObject({ kind: 'connecting', endpointStatus: 'connecting' });
        await act(async () => { publishAppliedActiveServerRuntimeAvailability(true); });
        await flushHookEffects();
        expect(hook.getCurrent()).toMatchObject({ kind: 'healthy', endpointStatus: 'online', primaryMachineLabel: 'applied-a' });
    });
});
