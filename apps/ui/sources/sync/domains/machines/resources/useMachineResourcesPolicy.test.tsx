import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MachineResourcesPolicyV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';

import { createDeferred, createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

installApprovalCommonModuleMocks();
installDisconnectedServerSocketBoundary();

const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
// The scoped machine network transport is the boundary; hooks, sync state and Action admission stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: transport.rpc }));
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { storage } = await import('@/sync/domains/state/storageStore');
const { useMachineResourcesPolicy } = await import('./useMachineResourcesPolicy');
const { machineResourcesPolicyGet } = await import('@/sync/ops/machineResourcesPolicy');
const { getActiveServerAccountScope, retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded } = await import('@/sync/domains/machines/reachability/machineReachability');
const HOME = 'srv_resources_policy';
const before = storage.getState();
beforeEach(async () => { await home.reset(); await actionHome(); });
afterEach(async () => {
    standardCleanup(); storage.setState(before); transport.rpc.mockReset();
    clearMachineRequestReachabilityForTest();
    retireActiveServerAccountScopeLifetime(); await home.reset();
});

function machine(overrides: Partial<Machine> = {}) {
    return createMachineFixture({ id: 'machine', activeAt: Date.now(), storageMode: 'plain', isShared: false,
        access: { role: 'manage', custodian: { accountId: 'owner', displayName: 'Owner' }, resourceMode: 'plain', accessState: 'ready' },
        daemonState: { resources: { v: 1, vitals: { state: 'reporting' },
            host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 }, attention: { level: 'calm', reasons: [] } } },
        ...overrides });
}
function setMachine(value: Machine, serverId = HOME) {
    storage.setState({ machines: {}, machineListByServerId: { [serverId]: [value] }, machineListStatusByServerId: { [serverId]: 'idle' } });
}

async function actionHome() {
    const id = await home.addHome({ name: 'Policy Home', serverUrl: 'https://resources-policy.test', serverIdentityId: HOME, accountId: 'owner', currentAccount: true });
    home.answer(id, '/v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 1 } });
    storage.setState({ profileScope: { serverId: HOME, accountId: 'owner' } });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    return { id, portableId: HOME };
}

describe('Machine resources policy synced reads', () => {
    it('retains policy but refuses writes after exact-Home failure and restores editing on success without a row update', async () => {
        setMachine(machine());
        const hook = await renderHook(() => useMachineResourcesPolicy({ serverId: HOME, machineId: 'machine' }));
        try {
            await act(async () => { await waitForHomeGovernance(() => expect(hook.getCurrent().editable).toBe(true)); });
            await act(async () => recordMachineRequestFailed({ serverId: 'other-home', accountId: 'owner', machineId: 'machine', observedAtMs: 1 }));
            expect(hook.getCurrent().editable).toBe(true);
            await act(async () => recordMachineRequestFailed({ serverId: HOME, accountId: 'owner', machineId: 'machine', observedAtMs: 2 }));
            expect(hook.getCurrent()).toMatchObject({ status: 'ready', revision: 1, editable: false, readOnlyReason: 'offline' });
            expect(await hook.getCurrent().set({ alerts: { memory: { enabled: true } } }))
                .toMatchObject({ saved: false, status: 'read_only', reason: 'offline' });
            expect(transport.rpc).not.toHaveBeenCalled();
            await act(async () => recordMachineRequestSucceeded({ serverId: HOME, accountId: 'owner', machineId: 'machine', observedAtMs: 3 }));
            expect(hook.getCurrent()).toMatchObject({ status: 'ready', editable: true, readOnlyReason: null });
        } finally { await hook.unmount(); }
    });
    it('reads defaults without content keys or network, and retains last-known policy offline', async () => {
        const current = machine();
        setMachine(current);
        const hook = await renderHook(() => useMachineResourcesPolicy({ serverId: HOME, machineId: 'machine' }));
        await act(async () => { await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', policy: MachineResourcesPolicyV1Schema.parse({ v: 1 }), revision: 1, editable: true, readOnlyReason: null })); });
        expect(machineResourcesPolicyGet('machine', { serverId: HOME })).toMatchObject({ status: 'ready', source: 'default', revision: 1 });
        await act(async () => { setMachine({ ...current, active: false, activeAt: 1 }); });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', revision: 1, editable: false, readOnlyReason: 'offline' });
        expect(transport.rpc).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('lets Manage recipients edit, keeps Use read-only, and does not disclose locked metadata', async () => {
        const current = machine({ isShared: true });
        setMachine(current);
        const hook = await renderHook(() => useMachineResourcesPolicy({ serverId: HOME, machineId: 'machine' }));
        await act(async () => { await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', editable: true, readOnlyReason: null })); });
        await act(async () => { setMachine({ ...current, access: { ...current.access!, role: 'use' } }); });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', editable: false, readOnlyReason: 'not_custodian' });
        await act(async () => { setMachine({ ...current, availability: { kind: 'locked', reason: 'decryption_failed' } }); });
        expect(hook.getCurrent()).toMatchObject({ status: 'locked', policy: null, revision: null, editable: false });
        expect(machineResourcesPolicyGet('machine', { serverId: HOME })).toEqual({ status: 'locked' });
        expect(transport.rpc).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('makes older Happier read-only and resolves only the exact Home and machine', async () => {
        setMachine(machine({ daemonState: {}, isShared: undefined, access: undefined }));
        const hook = await renderHook(() => useMachineResourcesPolicy({ serverId: HOME, machineId: 'machine' }));
        await act(async () => { await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', editable: false, readOnlyReason: 'older_happier' })); });
        expect(machineResourcesPolicyGet('machine', { serverId: 'other-home' })).toEqual({ status: 'unavailable' });
        expect(machineResourcesPolicyGet('missing', { serverId: HOME })).toEqual({ status: 'unavailable' });
        await hook.unmount();
    });

    it.each(['helper_missing', 'reader_failed'] as const)('admits a modern no-host unavailable publication (%s)', async reason => {
        setMachine(machine({ daemonState: { resources: { v: 1, vitals: { state: 'unavailable', reason, since: 1 },
            attention: { level: 'calm', reasons: [] } } } }));
        const hook = await renderHook(() => useMachineResourcesPolicy({ serverId: HOME, machineId: 'machine' }));
        await act(async () => { await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', revision: 1, editable: true, readOnlyReason: null })); });
        expect(transport.rpc).not.toHaveBeenCalled();
        await hook.unmount();
    });
});

describe('Machine resources policy Action saves', () => {
    it('dispatches overlapping local intents against each accepted revision, including a repeated field', async () => {
        const target = await actionHome();
        setMachine(machine(), target.id);
        const first = createDeferred<unknown>();
        const p1 = MachineResourcesPolicyV1Schema.parse({ v: 1, guard: { memoryGuard: { enabled: true } } });
        const p2 = MachineResourcesPolicyV1Schema.parse({ ...p1, alerts: { cpu: { enabled: true } } });
        const p3 = MachineResourcesPolicyV1Schema.parse({ ...p2, guard: { ...p2.guard, memoryGuard: { ...p2.guard.memoryGuard, enabled: false } } });
        const revisions: number[] = [];
        transport.rpc.mockImplementation(({ payload }: { payload: { expectedRevision: number } }) => {
            revisions.push(payload.expectedRevision);
            if (revisions.length === 1) return first.promise;
            return { status: 'applied', policy: revisions.length === 2 ? p2 : p3, revision: revisions.length + 1 };
        });
        const hook = await renderHook(() => useMachineResourcesPolicy({ serverId: target.id, machineId: 'machine' }));
        await act(async () => { await waitForHomeGovernance(() => expect(hook.getCurrent().editable).toBe(true)); });
        let saves: Promise<unknown>[] = [];
        await act(async () => {
            expect(getActiveServerAccountScope()).toMatchObject({ accountId: 'owner' });
            saves = [
                hook.getCurrent().set({ guard: { memoryGuard: { enabled: true } } }),
                hook.getCurrent().set({ alerts: { cpu: { enabled: true } } }),
                hook.getCurrent().set({ guard: { memoryGuard: { enabled: false } } }),
            ];
            await vi.waitFor(() => expect(revisions).toEqual([1]));
        });
        await act(async () => {
            first.resolve({ status: 'applied', policy: p1, revision: 2 });
            expect(await Promise.all(saves)).toEqual(expect.arrayContaining([
                expect.objectContaining({ saved: true, revision: 2 }),
                expect.objectContaining({ saved: true, revision: 3 }),
                expect.objectContaining({ saved: true, revision: 4 }),
            ]));
        });
        expect(revisions).toEqual([1, 2, 3]);
        expect(hook.getCurrent()).toMatchObject({ policy: p3, revision: 4 });
        await hook.unmount();
    });

    it('does not dispatch queued intent or retain a receipt after its Account lifetime retires', async () => {
        const target = await actionHome();
        setMachine(machine(), target.id);
        const first = createDeferred<unknown>();
        transport.rpc.mockReturnValue(first.promise);
        const hook = await renderHook(() => useMachineResourcesPolicy({ serverId: target.id, machineId: 'machine' }));
        await act(async () => { await waitForHomeGovernance(() => expect(hook.getCurrent().editable).toBe(true)); });
        expect(getActiveServerAccountScope()).toMatchObject({ accountId: 'owner' });
        let saves: Promise<unknown>[] = [];
        await act(async () => {
            saves = [hook.getCurrent().set({ alerts: { memory: { enabled: true } } }),
                hook.getCurrent().set({ alerts: { cpu: { enabled: true } } })];
            await vi.waitFor(() => expect(transport.rpc).toHaveBeenCalledTimes(1));
            retireActiveServerAccountScopeLifetime();
            first.resolve({ status: 'applied', policy: MachineResourcesPolicyV1Schema.parse({ v: 1 }), revision: 2 });
            expect(await Promise.all(saves)).toEqual([expect.objectContaining({ saved: false }), expect.objectContaining({ saved: false })]);
        });
        expect(transport.rpc).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().revision).toBe(1);
        await hook.unmount();
    });

    it('reads offline synced policy through the account-placed Action without a machine RPC', async () => {
        const target = await actionHome();
        setMachine(machine({ active: false, activeAt: 1 }), target.id);
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('machines.resources.policy.get', { serverId: target.id, machineId: 'machine' }, { surface: 'ui' }))
            .toMatchObject({ ok: true, result: { status: 'ready', source: 'default', revision: 1 } });
        expect(transport.rpc).not.toHaveBeenCalled();
    });

    it('sends a minimal patch through the canonical Action and keeps the policy-only receipt until sync catches up', async () => {
        const target = await actionHome();
        const initial = machine();
        setMachine(initial, target.id);
        const policy = MachineResourcesPolicyV1Schema.parse({ v: 1, alerts: { memory: { enabled: true } } });
        transport.rpc.mockResolvedValue({ status: 'applied', policy, revision: 2 });
        const hook = await renderHook(() => useMachineResourcesPolicy({ serverId: target.id, machineId: 'machine' }));
        await act(async () => { await waitForHomeGovernance(() => expect(hook.getCurrent().editable).toBe(true)); });
        await act(async () => {
            expect(await hook.getCurrent().set({ alerts: { memory: { enabled: true } } }))
                .toMatchObject({ saved: true, status: 'applied', policy, revision: 2 });
        });
        expect(transport.rpc).toHaveBeenCalledWith(expect.objectContaining({ method: 'machines.resources.policy.set', serverId: target.portableId,
            machineId: 'machine', payload: { serverId: target.portableId, machineId: 'machine', expectedRevision: 1, patch: { alerts: { memory: { enabled: true } } } } }));
        expect(hook.getCurrent()).toMatchObject({ policy, revision: 2 });
        expect(storage.getState().machineListByServerId[target.id]?.[0]?.metadataVersion).toBe(1);
        await act(async () => { setMachine({ ...initial, availability: { kind: 'locked', reason: 'decryption_failed' } }, target.id); });
        expect(hook.getCurrent()).toMatchObject({ status: 'locked', policy: null, revision: null, editable: false });
        const synced = MachineResourcesPolicyV1Schema.parse({ v: 1, alerts: { cpu: { enabled: true } } });
        await act(async () => { setMachine({ ...initial, metadataVersion: 3, metadata: { ...initial.metadata!, resourcesPolicyV1: synced } }, target.id); });
        expect(hook.getCurrent()).toMatchObject({ policy: synced, revision: 3 });
        await hook.unmount();
    });

    it('returns conflict and failure with current truth, and refuses read-only saves before transport', async () => {
        const target = await actionHome();
        const initial = machine();
        setMachine(initial, target.id);
        const winner = MachineResourcesPolicyV1Schema.parse({ v: 1, alerts: { memory: { level: 'elevated' } } });
        transport.rpc.mockResolvedValue({ status: 'conflict', policy: winner, revision: 2 });
        const hook = await renderHook(() => useMachineResourcesPolicy({ serverId: target.id, machineId: 'machine' }));
        await act(async () => { await waitForHomeGovernance(() => expect(hook.getCurrent().editable).toBe(true)); });
        await act(async () => {
            expect(await hook.getCurrent().set({ alerts: { memory: { enabled: true } } }))
                .toMatchObject({ saved: false, status: 'conflict', policy: winner, revision: 2 });
        });
        expect(hook.getCurrent()).toMatchObject({ policy: winner, revision: 2 });
        transport.rpc.mockResolvedValue({ status: 'unavailable', reason: 'machine_offline' });
        await act(async () => {
            expect(await hook.getCurrent().set({ alerts: { memory: { enabled: true } } }))
                .toMatchObject({ saved: false, status: 'unavailable', reason: 'machine_offline', policy: winner, revision: 2 });
        });
        await act(async () => { setMachine({ ...initial, active: false, activeAt: 1 }, target.id); });
        transport.rpc.mockClear();
        expect(await hook.getCurrent().set({ alerts: { memory: { enabled: true } } }))
            .toMatchObject({ saved: false, status: 'read_only', reason: 'offline', policy: winner, revision: 2 });
        expect(transport.rpc).not.toHaveBeenCalled();
        await hook.unmount();
    });
});
