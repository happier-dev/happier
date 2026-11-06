import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const home = createHomeGovernanceHarness();
const serverId = 'srv_inbox_reachability';
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
const { storage } = await import('@/sync/domains/state/storageStore');
const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
const { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { recordMachineRequestFailed, clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
const { useInboxMachineReachability } = await import('./useInboxMachineReachability');

beforeEach(async () => {
    await home.reset();
    await home.addHome({ name: 'Inbox Home', serverUrl: 'https://inbox-reachability.example.test', serverIdentityId: serverId, accountId: 'account-a' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://inbox-reachability.example.test', serverIdentityId: serverId,
        accountId: 'account-a', request: async (input, init) => await home.request(input, init) ?? null });
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    actionOperationStore.reset();
});

afterEach(async () => {
    standardCleanup();
    actionOperationStore.reset();
    clearMachineRequestReachabilityForTest();
    vi.restoreAllMocks();
    await connection?.dispose();
    connection = undefined;
    await home.reset();
});

function reboot(machineId: string, operationId = 'reboot'): ActionOperationSnapshotV1 {
    return { version: 1, operationId, revision: 1, actionId: 'machines.reboot', state: 'running',
        scope: { accountId: 'account-a', machineId }, title: 'Reboot', createdAt: 1, cancellation: 'unsupported',
        domainRef: { kind: 'machineReboot', serverId, machineId, installationId: 'installation-a',
            task: { id: 'reboot-task', taskKind: 'machine.reboot.v1' },
            basis: { dispatchStarted: true, bootedAt: 1, expectedRunningServiceIds: [], expectedRunningServicesKnown: true } } };
}

describe('Inbox Machine reachability data', () => {
    it('does not read fleet rows without a reboot subject', async () => {
        const machine = createMachineFixture({ active: false, activeAt: 1 });
        let reads = 0;
        machine.metadata = new Proxy(machine.metadata!, { get(target, key, receiver) {
            reads += 1;
            return Reflect.get(target, key, receiver);
        } });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        reads = 0;
        const hook = await renderHook(() => useInboxMachineReachability(captureActiveServerAccountScopeLifetime()));
        try {
            expect(hook.getCurrent()).toEqual([]);
            expect(reads).toBe(0);
        } finally { await hook.unmount(); }
    });

    it('preserves selected identity and performs no selected reads, renders or timer scheduling for unrelated arrivals', async () => {
        const selected = createMachineFixture({ id: 'selected-reboot', installationId: 'installation-a', active: false, activeAt: 1 });
        let nameReads = 0;
        selected.metadata = new Proxy(selected.metadata!, { get(target, key, receiver) {
            if (key === 'displayName') nameReads += 1;
            return Reflect.get(target, key, receiver);
        } });
        const neighbors = Array.from({ length: 127 }, (_, index) => createMachineFixture({ id: `neighbor-${index}`, active: false, activeAt: 1 }));
        storage.getState().applyMachines([selected, ...neighbors], true, { sourceServerId: serverId });
        recordMachineRequestFailed({ serverId, accountId: 'account-a', machineId: selected.id });
        actionOperationStore.mergeSnapshots({ serverId, snapshots: [reboot(selected.id)] });
        const lifetime = captureActiveServerAccountScopeLifetime();
        expect(lifetime).not.toBeNull();
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useInboxMachineReachability(lifetime); });
        try {
            expect(hook.getCurrent()[0]).toMatchObject({ reachability: 'unreachable', expectedDuring: 'reboot' });
            const before = hook.getCurrent();
            const beforeRenders = renders;
            const beforeRequests = home.requests.length;
            nameReads = 0;
            const timeout = vi.spyOn(globalThis, 'setTimeout');
            const interval = vi.spyOn(globalThis, 'setInterval');
            for (let index = 0; index < 8; index += 1) await act(async () => {
                const neighbor = neighbors[index]!;
                storage.getState().applyMachines([{ ...neighbor, metadataVersion: 2,
                    metadata: { ...neighbor.metadata!, displayName: `Changed ${index}` } }], false, { sourceServerId: serverId });
                actionOperationStore.mergeSnapshots({ serverId, snapshots: [{ ...reboot(neighbor.id, `other-operation-${index}`),
                    actionId: 'session.spawn_new', domainRef: undefined }] });
                actionOperationStore.mergeSnapshots({ serverId: 'foreign-home', snapshots: [reboot(selected.id, `foreign-reboot-${index}`)] });
                actionOperationStore.mergeSnapshots({ serverId, snapshots: [{ ...reboot(selected.id, `foreign-account-reboot-${index}`),
                    scope: { machineId: selected.id, accountId: 'foreign-account' } }] });
            });
            expect(hook.getCurrent()).toBe(before);
            expect(renders).toBe(beforeRenders);
            expect(nameReads, 'selected display-name reads on unrelated arrivals').toBe(0);
            expect(home.requests.length, 'HTTP requests on unrelated arrivals').toBe(beforeRequests);
            expect(timeout).not.toHaveBeenCalled();
            expect(interval).not.toHaveBeenCalled();
            await act(async () => storage.getState().applyMachines([{ ...selected, metadataVersion: 2,
                metadata: { ...selected.metadata!, displayName: 'Renamed target' } }], false, { sourceServerId: serverId }));
            expect(hook.getCurrent()[0]?.name).toBe('Renamed target');
            expect(hook.getCurrent()[0]?.expectedDuring).toBe('reboot');
        } finally { await hook.unmount(); }
    });

    it('keeps known dispatch distinct from transport loss, and withdraws expectation with unreadable Machine facts or retired Account', async () => {
        const machine = createMachineFixture({ id: 'readable-reboot', installationId: 'installation-a', activeAt: Date.now() });
        recordMachineRequestFailed({ serverId, accountId: 'account-a', machineId: machine.id });
        actionOperationStore.mergeSnapshots({ serverId, snapshots: [reboot(machine.id)] });
        const lifetime = captureActiveServerAccountScopeLifetime();
        const hook = await renderHook(() => useInboxMachineReachability(lifetime));
        try {
            expect(hook.getCurrent()[0]).toMatchObject({ reachability: 'unknown', expectedDuring: null });
            await act(async () => storage.getState().applyMachines([machine], true, { sourceServerId: serverId }));
            expect(hook.getCurrent()[0]?.expectedDuring).toBe('reboot');
            await act(async () => actionOperationStore.setMachineObservation({ serverId, machineId: machine.id }, 'unavailable'));
            expect(hook.getCurrent()[0]).toMatchObject({ expectedDuring: 'reboot', operation: { observation: 'unavailable' } });
            await act(async () => storage.getState().applyMachines([{ ...machine, metadataVersion: 2,
                availability: { kind: 'locked', reason: 'encryption_material_unavailable' }, metadata: null }], false, { sourceServerId: serverId }));
            expect(hook.getCurrent()[0]?.expectedDuring).toBeNull();
            await act(async () => retireActiveServerAccountScopeLifetime());
            expect(lifetime?.isCurrent()).toBe(false);
            expect(hook.getCurrent()).toEqual([]);
        } finally { await hook.unmount(); }
    });

    it('does not resurrect older expectation after a newer reboot was cancelled or its success dismissed', async () => {
        const machine = createMachineFixture({ id: 'latest-reboot', installationId: 'installation-a', active: false, activeAt: 1 });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        recordMachineRequestFailed({ serverId, accountId: 'account-a', machineId: machine.id });
        actionOperationStore.mergeSnapshots({ serverId, snapshots: [reboot(machine.id, 'older-active'),
            { ...reboot(machine.id, 'newer-cancelled'), state: 'cancelled', createdAt: 2, settledAt: 3 }] });
        const hook = await renderHook(() => useInboxMachineReachability(captureActiveServerAccountScopeLifetime()));
        try {
            expect(hook.getCurrent()).toEqual([expect.objectContaining({ reachability: 'unreachable', expectedDuring: null,
                operation: expect.objectContaining({ snapshot: expect.objectContaining({ operationId: 'newer-cancelled' }) }) })]);
            await act(async () => {
                actionOperationStore.reset();
                actionOperationStore.mergeSnapshots({ serverId, snapshots: [reboot(machine.id, 'older-active'),
                    { ...reboot(machine.id, 'newer-succeeded'), state: 'succeeded', createdAt: 2, settledAt: 3 }] });
                actionOperationStore.dismissRecentSucceeded();
            });
            expect(hook.getCurrent()).toEqual([expect.objectContaining({ reachability: 'unreachable', expectedDuring: null,
                operation: expect.objectContaining({ snapshot: expect.objectContaining({ operationId: 'newer-succeeded' }) }) })]);
        } finally { await hook.unmount(); }
    });
});
