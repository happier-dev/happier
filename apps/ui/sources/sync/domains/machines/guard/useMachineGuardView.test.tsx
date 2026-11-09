import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MachineResourcesPolicyV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { MachineGuardViewV1Schema } from '@happier-dev/protocol/machines/guard/guardRpcV1';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createMachineGuardViewFixture } from './guardViewFixtures';

installDisconnectedServerSocketBoundary();
const network = vi.hoisted(() => ({ rpc: vi.fn() }));
// Only the authenticated machine connection is replaced; Actions, credentials, hook and store stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(network.rpc);
});
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
// Scoped HTTP transports must bind after their genuine Home boundaries are installed.
const { storage } = await import('@/sync/domains/state/storageStore');
const { machineGuardStore } = await import('./machineGuardStore');
const { useMachineGuardView, useMachineGuardActivity, useMachinesGuardActivity } = await import('./useMachineGuardView');
const guardRpc = await import('./machineGuardRpc');
const before = storage.getState();
beforeEach(async () => { await home.reset(); });
afterEach(async () => {
    standardCleanup(); machineGuardStore.reset(); network.rpc.mockReset(); storage.setState(before); await home.reset();
});

it('decodes the registered Guard Action answer without admitting an unknown result', async () => {
    const serverId = await home.addHome({ name: 'Guard contract', serverUrl: 'https://guard-contract.test',
        serverIdentityId: 'srv_guard_contract', accountId: 'owner', currentAccount: true });
    const input = { serverId, machineId: 'machine', expectedAccountId: 'owner' };
    const view = MachineGuardViewV1Schema.parse(createMachineGuardViewFixture());
    network.rpc.mockImplementation(async ({ method, accountId }: { method: string; accountId?: string }) => {
        expect({ method, accountId }).toEqual({ method: RPC_METHODS.MACHINES_GUARD_GET, accountId: 'owner' });
        return view;
    });
    expect(await guardRpc.fetchMachineGuardViewViaAction(input)).toEqual({ ok: true, value: view });
    network.rpc.mockResolvedValue({ ...view, policyRevision: 'unproven' });
    expect(await guardRpc.fetchMachineGuardViewViaAction(input)).toMatchObject({ ok: false, reason: 'invalid_response' });
});

it('streams Activity receipts through the consumed hook without acquiring a Guard view', async () => {
    const serverId = await home.addHome({ name: 'Activity only', serverUrl: 'https://activity-only.test',
        serverIdentityId: 'srv_activity_only', accountId: 'owner', currentAccount: true });
    home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 1 } });
    storage.setState({ machines: {}, machineListByServerId: { [serverId]: [createMachineFixture({
        id: 'machine', activeAt: Date.now(), storageMode: 'plain', isShared: false,
        metadata: { host: 'Activity machine', platform: 'linux', happyCliVersion: '0.3.0', happyHomeDir: '/home/test/.happier', homeDir: '/home/test' },
        access: { role: 'manage', custodian: { accountId: 'owner', displayName: 'Owner' }, resourceMode: 'plain', accessState: 'ready' },
    })] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    const replies: Array<ReturnType<typeof createDeferred<unknown>>> = [];
    const list = { entries: [], counts: { stopped: 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: 1000 };
    network.rpc.mockImplementation(async ({ method }: { method: string }) => {
        if (method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST) return list;
        if (method === RPC_METHODS.DAEMON_GUARD_ACTIVITY_WATCH) {
            const reply = createDeferred<unknown>(); replies.push(reply); return reply.promise;
        }
        throw new Error(`unexpected ${method}`);
    });
    const hook = await renderHook(() => useMachineGuardActivity({ serverId, machineId: 'machine', range: '7d', filter: 'all' }));
    await act(async () => { await vi.waitFor(() => expect(replies).toHaveLength(1)); });
    const entries = [{ v: 1, id: 'append', at: 2000, kind: 'housekeeping', rule: 'housekeeping', outcome: 'done', attribution: { kind: 'unknown' } }];
    await act(async () => { replies[0]!.resolve({ changed: true, since: 2, list: { entries,
        counts: { stopped: 0, cleanedUp: 1, needsLook: 0, others: 0 }, asOf: 2000 } }); });
    await act(async () => { await vi.waitFor(() => expect(hook.getCurrent().list?.entries).toEqual(entries)); });
    expect(network.rpc.mock.calls.map(([request]) => request.method)).toEqual([
        RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST, RPC_METHODS.DAEMON_GUARD_ACTIVITY_WATCH, RPC_METHODS.DAEMON_GUARD_ACTIVITY_WATCH,
    ]);
    await hook.unmount();
});

it('distinguishes unavailable transport from missing Guard operations across reads, watches and Keep running', async () => {
    const serverId = await home.addHome({ name: 'Guard predecessor', serverUrl: 'https://guard-predecessor.test',
        serverIdentityId: 'srv_guard_predecessor', accountId: 'owner', currentAccount: true });
    const input = { serverId, machineId: 'machine', expectedAccountId: 'owner' };
    for (const errorCode of [RPC_ERROR_CODES.METHOD_NOT_FOUND, RPC_ERROR_CODES.METHOD_NOT_AVAILABLE]) {
        network.rpc.mockRejectedValue(new RpcError('Unavailable operation', errorCode));
        const reason = errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND ? 'older_happier' : 'request_failed';
        expect(await guardRpc.fetchMachineGuardViewViaAction(input)).toMatchObject({ ok: false, reason });
        expect(await guardRpc.fetchMachineGuardActivityViaAction({ ...input, range: 'today', filter: 'all' }))
            .toMatchObject({ ok: false, reason });
        expect(await guardRpc.watchMachineGuardViaMachineRpc(input)).toMatchObject({ ok: false, reason });
        expect(await guardRpc.watchMachineGuardActivityViaMachineRpc({ ...input, range: '7d', filter: 'all' }))
            .toMatchObject({ ok: false, reason });
        expect(await guardRpc.keepMachineGuardWorkRunningViaAction({ ...input, terminalKey: 'terminal' }))
            .toMatchObject({ ok: false, reason });
    }
    const failureCause = { phase: 'dispatch' as const, errorClass: 'RpcError', errorCode: RPC_ERROR_CODES.FORBIDDEN, httpStatus: 403 };
    network.rpc.mockRejectedValue(new RpcError('Forbidden', RPC_ERROR_CODES.FORBIDDEN, failureCause));
    const failure = { ok: false, reason: 'request_failed', errorCode: RPC_ERROR_CODES.FORBIDDEN, failureCause };
    expect(await guardRpc.fetchMachineGuardViewViaAction(input)).toEqual(failure);
    expect(await guardRpc.watchMachineGuardViaMachineRpc(input)).toEqual(failure);
});

it('distinguishes an empty or held pending read, failure and offline without losing the last good answer', async () => {
    const serverId = await home.addHome({ name: 'Guard pending', serverUrl: 'https://guard-pending.test', serverIdentityId: 'srv_guard_pending', accountId: 'owner' });
    home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 1 } });
    storage.setState({ machines: {}, machineListByServerId: { [serverId]: [createMachineFixture({
        id: 'machine', activeAt: Date.now(), storageMode: 'plain', isShared: false,
        metadata: { host: 'Guard machine', platform: 'linux', happyCliVersion: '0.3.0', happyHomeDir: '/home/test/.happier', homeDir: '/home/test' },
        access: { role: 'manage', custodian: { accountId: 'owner', displayName: 'Owner' }, resourceMode: 'plain', accessState: 'ready' },
    })] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    const replies: Array<ReturnType<typeof createDeferred<unknown>>> = [];
    network.rpc.mockImplementation(async ({ method }: { method: string }) => {
        if (method === RPC_METHODS.DAEMON_GUARD_WATCH) return new Promise(() => {});
        if (method !== RPC_METHODS.MACHINES_GUARD_GET) throw new Error(`unexpected ${method}`);
        const reply = createDeferred<unknown>(); replies.push(reply); return reply.promise;
    });
    const hook = await renderHook(({ online }: { online: boolean }) => useMachineGuardView({ serverId, machineId: 'machine', online }), { initialProps: { online: true } });
    await act(async () => { await vi.waitFor(() => expect({ reads: replies.length, status: hook.getCurrent().status }).toEqual({ reads: 1, status: 'loading' })); });
    expect(hook.getCurrent()).toMatchObject({ status: 'loading', pending: true, offline: false, view: null, receivedAtMs: null,
        on: null, settings: { policy: { guard: { memoryGuard: { enabled: false } } } } });
    await act(async () => { replies[0]!.resolve(createMachineGuardViewFixture()); });
    await act(async () => { await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready')); });
    const last = hook.getCurrent();
    expect(last.on).toBe(false);
    // A newer setting is intent, not proof that the retained daemon execution view applied it.
    await act(async () => {
        const machine = storage.getState().machineListByServerId[serverId]![0]!;
        storage.setState({ machineListByServerId: { [serverId]: [{ ...machine, metadataVersion: 2,
            metadata: { ...machine.metadata!, resourcesPolicyV1: MachineResourcesPolicyV1Schema.parse({ v: 1, guard: { memoryGuard: { enabled: true } } }) } }] } });
    });
    expect(hook.getCurrent()).toMatchObject({ on: false, settings: { revision: 2, policy: { guard: { memoryGuard: { enabled: true } } } } });
    await act(async () => { last.retry(); });
    await act(async () => { await vi.waitFor(() => expect(replies).toHaveLength(2)); });
    expect(hook.getCurrent()).toMatchObject({ status: 'ready', pending: true, on: false, receivedAtMs: last.receivedAtMs });
    expect(hook.getCurrent().view).toBe(last.view);
    await act(async () => { replies[1]!.reject(new Error('Machine unavailable')); });
    await act(async () => { await vi.waitFor(() => expect(hook.getCurrent().status).toBe('error')); });
    expect(hook.getCurrent()).toMatchObject({ pending: false, on: false, receivedAtMs: last.receivedAtMs });
    expect(hook.getCurrent().view).toBe(last.view);
    await act(async () => { hook.getCurrent().retry(); });
    await act(async () => { await vi.waitFor(() => expect(replies).toHaveLength(3)); });
    await act(async () => { await publishMachineInventoryForTest({ serverId, accountId: 'owner' },
        storage.getState().machineListByServerId[serverId]!.map(machine => ({ ...machine, active: false, activeAt: 1 }))); });
    await hook.rerender({ online: false });
    expect(hook.getCurrent()).toMatchObject({ offline: true, pending: false, on: false, receivedAtMs: last.receivedAtMs });
    expect(hook.getCurrent().view).toBe(last.view);
    await act(async () => { replies[2]!.resolve(createMachineGuardViewFixture({ policyRevision: 2 })); });
    expect(hook.getCurrent().view).toBe(last.view);
    await hook.unmount();
});

it('keeps a failed initial daemon view unknown even when the synced rule is enabled', async () => {
    const serverId = await home.addHome({ name: 'Guard failed', serverUrl: 'https://guard-failed.test', serverIdentityId: 'srv_guard_failed', accountId: 'owner' });
    home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 1 } });
    storage.setState({ machines: {}, machineListByServerId: { [serverId]: [createMachineFixture({
        id: 'machine', activeAt: Date.now(), storageMode: 'plain', isShared: false,
        metadata: { host: 'Guard machine', platform: 'linux', happyCliVersion: '0.3.0', happyHomeDir: '/home/test/.happier', homeDir: '/home/test',
            resourcesPolicyV1: MachineResourcesPolicyV1Schema.parse({ v: 1, guard: { memoryGuard: { enabled: true } } }) },
    })] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    network.rpc.mockRejectedValue(new Error('Request failed'));
    const hook = await renderHook(() => useMachineGuardView({ serverId, machineId: 'machine' }));
    await act(async () => { await vi.waitFor(() => expect(hook.getCurrent().status).toBe('error')); });
    expect(hook.getCurrent()).toMatchObject({ view: null, on: null, pending: false, receivedAtMs: null,
        settings: { policy: { guard: { memoryGuard: { enabled: true } } } } });
    await hook.unmount();
});

it('keeps every other machine\'s Activity read and watch when one machine of the fleet goes offline', async () => {
    const serverId = await home.addHome({ name: 'Activity fleet', serverUrl: 'https://activity-fleet.test',
        serverIdentityId: 'srv_activity_fleet', accountId: 'owner', currentAccount: true });
    home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 1 } });
    const machine = (id: string) => createMachineFixture({ id, activeAt: Date.now(), storageMode: 'plain', isShared: false,
        metadata: { host: id, platform: 'linux', happyCliVersion: '0.3.0', happyHomeDir: '/home/test/.happier', homeDir: '/home/test' },
        access: { role: 'manage', custodian: { accountId: 'owner', displayName: 'Owner' }, resourceMode: 'plain', accessState: 'ready' } });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, ['a', 'b', 'c'].map(machine));
    const list = { entries: [], counts: { stopped: 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: 1000 };
    const reads: string[] = [];
    network.rpc.mockImplementation(async ({ method, machineId }: { method: string; machineId?: string }) => {
        if (method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST) { reads.push(String(machineId)); return list; }
        if (method === RPC_METHODS.DAEMON_GUARD_ACTIVITY_WATCH) return new Promise(() => {});
        throw new Error(`unexpected ${method}`);
    });
    const hook = await renderHook(() => useMachinesGuardActivity({ serverId, machineIds: ['a', 'b', 'c'], range: '7d', filter: 'all' }));
    await act(async () => { await vi.waitFor(() => expect(hook.getCurrent().map(entry => entry.status)).toEqual(['ready', 'ready', 'ready'])); });
    const settled = hook.getCurrent();
    reads.length = 0;
    // Presence of one machine flips (a flapping or sleeping Machine). Its own read stops; a and b are untouched.
    await act(async () => { await publishMachineInventoryForTest({ serverId, accountId: 'owner' },
        [machine('a'), machine('b'), { ...machine('c'), active: false, activeAt: 1 }]); });
    await act(async () => { await vi.waitFor(() => expect(hook.getCurrent()[2]!.offline).toBe(true)); });
    expect({ reads, statuses: hook.getCurrent().map(entry => entry.status) }).toEqual({ reads: [], statuses: ['ready', 'ready', 'ready'] });
    expect(hook.getCurrent()[0]!.list).toBe(settled[0]!.list);
    await hook.unmount();
});
