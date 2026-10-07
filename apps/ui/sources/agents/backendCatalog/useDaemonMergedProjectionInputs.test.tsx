import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

let captureActiveServerAccountScopeLifetime: typeof import('@/sync/domains/scope/activeServerAccountScope').captureActiveServerAccountScopeLifetime;
let publishMachineContributionRegistryProjectionInvalidation: typeof import('@/sync/ops/machineContributionRegistryProjectionRevision').publishMachineContributionRegistryProjectionInvalidation;
let clearDaemonMergedProjectionCacheForTests: typeof import('./loadDaemonMergedProjectionInputs').clearDaemonMergedProjectionCacheForTests;
let loadDaemonMergedProjectionCacheEntry: typeof import('./loadDaemonMergedProjectionInputs').loadDaemonMergedProjectionCacheEntry;
let useDaemonMergedProjectionInputs: typeof import('./useDaemonMergedProjectionInputs').useDaemonMergedProjectionInputs;

const daemonDescribe = vi.hoisted(() => vi.fn());
const homeIds = vi.hoisted(() => new Map<string, string>());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

function readyResponse(generation: number) {
    return { protocolVersion: 1 as const, projection: { v: 2 as const, generation, familiesById: {} } };
}

describe('useDaemonMergedProjectionInputs', () => {
    let network: Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>>;
    let serverId: string;
    let otherServerId: string;

    beforeEach(async () => {
        vi.resetModules();
        daemonDescribe.mockReset();
        daemonDescribe.mockResolvedValue(readyResponse(1));
        network = await installSessionOpsNetworkBoundary();
        const home = await network.addHome('https://projection-hook.example.test', 'account-a');
        const otherHome = await network.addHome('https://projection-hook-other.example.test', 'account-a');
        serverId = home.id;
        otherServerId = otherHome.id;
        homeIds.clear();
        homeIds.set(home.serverUrl, serverId);
        homeIds.set(otherHome.serverUrl, otherServerId);
        network.setRpcAckResponder(async (request) => {
            if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
            }
            return { ok: true, result: await daemonDescribe({ machineId: request.targetId, serverId: homeIds.get(request.serverUrl), method: request.method, payload: request.payload }) };
        });
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await loadSyncSingletonForTests();
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer({ token: home.token });
        ({ captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope'));
        ({ publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision'));
        ({ clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs'));
        ({ useDaemonMergedProjectionInputs } = await import('./useDaemonMergedProjectionInputs'));
        clearDaemonMergedProjectionCacheForTests();
    });
    afterEach(async () => {
        standardCleanup();
        clearDaemonMergedProjectionCacheForTests();
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
        network.dispose();
    });

    async function primeCache(generation: number, failRefresh = false) {
        daemonDescribe.mockResolvedValueOnce(readyResponse(generation));
        const scope = { machineId: 'machine-1', serverId };
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        expect(accountLifetime).not.toBeNull();
        await loadDaemonMergedProjectionCacheEntry({ ...scope, accountLifetime });
        if (failRefresh) {
            daemonDescribe.mockRejectedValueOnce(new Error('Transport unavailable'));
            await loadDaemonMergedProjectionCacheEntry({ ...scope, accountLifetime });
        }
        daemonDescribe.mockClear();
    }
    async function settledHook() {
        const hook = await renderHook(() => useDaemonMergedProjectionInputs({ machineId: 'machine-1', serverId }));
        await flushHookEffects({ cycles: 3, turns: 2 });
        await vi.waitFor(() => expect(hook.getCurrent().phase).toBe('ready'));
        return hook;
    }

    it('reloads the authoritative projection when plugin mutation invalidates the active machine scope', async () => {
        const hook = await settledHook();
        expect(hook.getCurrent().inputs?.pluginProjectionV2?.generation).toBe(1);
        const reload = createDeferred<ReturnType<typeof readyResponse>>();
        daemonDescribe.mockImplementationOnce(() => reload.promise);
        await act(async () => publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId }));
        expect(hook.getCurrent()).toMatchObject({ phase: 'loading', inputs: { pluginProjectionV2: { generation: 1 } } });
        reload.resolve(readyResponse(2));
        await vi.waitFor(() => expect(hook.getCurrent().inputs?.pluginProjectionV2?.generation).toBe(2));
        expect(daemonDescribe).toHaveBeenCalledTimes(2);
    });
    it('retains the last ready projection as stale metadata when an invalidation refresh fails', async () => {
        const hook = await settledHook();
        daemonDescribe.mockRejectedValueOnce(new Error('Transport unavailable'));
        await act(async () => publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId }));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'error', failureReason: 'error', inputs: { pluginProjectionV2: { generation: 1 } } }));
    });
    it('serves only the cached projection and never asks the machine when loading is off', async () => {
        await primeCache(4);
        const hook = await renderHook(() => useDaemonMergedProjectionInputs({ machineId: 'machine-1', serverId, load: false }));
        await flushHookEffects({ cycles: 3, turns: 2 });
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready', inputs: { pluginProjectionV2: { generation: 4 } } }));
        expect(daemonDescribe).not.toHaveBeenCalled();
    });
    it('restores inert stale metadata from an error cache entry after remount', async () => {
        await primeCache(1, true);
        daemonDescribe.mockRejectedValueOnce(new Error('Transport still unavailable'));
        const hook = await renderHook(() => useDaemonMergedProjectionInputs({ machineId: 'machine-1', serverId }));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'error', inputs: { pluginProjectionV2: { generation: 1 } } }));
    });
    it('revalidates instead of serving a fresh cached failure as authoritative', async () => {
        await primeCache(1, true);
        const phases: string[] = [];
        const hook = await renderHook(() => {
            const state = useDaemonMergedProjectionInputs({ machineId: 'machine-1', serverId });
            phases.push(state.phase);
            return state;
        });
        expect(phases[0]).toBe('loading');
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready', inputs: { pluginProjectionV2: { generation: 1 } } }));
        expect(daemonDescribe).toHaveBeenCalledTimes(1);
    });
    it('does not publish a fresh cached ready entry from the previous revision on first mount', async () => {
        await primeCache(1);
        publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId });
        const pending = createDeferred<ReturnType<typeof readyResponse>>();
        daemonDescribe.mockImplementationOnce(() => pending.promise);
        const hook = await renderHook(() => useDaemonMergedProjectionInputs({ machineId: 'machine-1', serverId }));
        expect(hook.getCurrent().phase).toBe('loading');
        await vi.waitFor(() => expect(daemonDescribe).toHaveBeenCalledTimes(1));
        pending.resolve(readyResponse(2));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready', inputs: { pluginProjectionV2: { generation: 2 } } }));
    });
    it('does not expose the previous machine projection while a newly selected machine loads', async () => {
        const pending = createDeferred<ReturnType<typeof readyResponse>>();
        daemonDescribe.mockImplementation((request: Readonly<{ machineId: string }>) => request.machineId === 'machine-2' ? pending.promise : readyResponse(1));
        const hook = await renderHook((machineId: string) => useDaemonMergedProjectionInputs({ machineId, serverId }), { initialProps: 'machine-1' });
        await vi.waitFor(() => expect(hook.getCurrent().phase).toBe('ready'));
        await hook.rerender('machine-2');
        expect(hook.getCurrent()).toEqual({ phase: 'loading', inputs: null });
        pending.resolve(readyResponse(2));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready', inputs: { pluginProjectionV2: { generation: 2 } } }));
    });
    it('does not expose a projection from another server when the machine id is unchanged', async () => {
        const pending = createDeferred<ReturnType<typeof readyResponse>>();
        daemonDescribe.mockImplementation((request: Readonly<{ serverId: string }>) => request.serverId === otherServerId ? pending.promise : readyResponse(1));
        const hook = await renderHook((selectedServerId: string) => useDaemonMergedProjectionInputs({ machineId: 'machine-1', serverId: selectedServerId }), { initialProps: serverId });
        await vi.waitFor(() => expect(hook.getCurrent().phase).toBe('ready'));
        await hook.rerender(otherServerId);
        expect(hook.getCurrent()).toEqual({ phase: 'loading', inputs: null });
        pending.resolve(readyResponse(2));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready', inputs: { pluginProjectionV2: { generation: 2 } } }));
    });
    it('can retain inert projection metadata across a route-driven authority change', async () => {
        const pending = createDeferred<ReturnType<typeof readyResponse>>();
        daemonDescribe.mockImplementation((request: Readonly<{ machineId: string }>) => request.machineId === 'machine-2' ? pending.promise : readyResponse(1));
        const hook = await renderHook(
            (scope: Readonly<{ machineId: string; serverId: string }>) => useDaemonMergedProjectionInputs({ ...scope, retainInputsAcrossScopeChange: true }),
            { initialProps: { machineId: 'machine-1', serverId } },
        );
        await vi.waitFor(() => expect(hook.getCurrent().phase).toBe('ready'));
        await hook.rerender({ machineId: 'machine-2', serverId: otherServerId });
        expect(hook.getCurrent()).toMatchObject({ phase: 'loading', inputs: { pluginProjectionV2: { generation: 1 } } });
        pending.resolve(readyResponse(2));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready', inputs: { pluginProjectionV2: { generation: 2 } } }));
    });
});
