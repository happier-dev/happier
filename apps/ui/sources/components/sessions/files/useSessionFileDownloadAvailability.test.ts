import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    session: { active: true } as any,
    machineReachability: { machineRpcTargetAvailable: true } as any,
    machineTarget: { machineId: 'machine-1', basePath: '/repo' } as any,
    cachedMachineRpcDirectRoute: { status: 'unknown' as const },
    serverSnapshot: {
        status: 'ready' as const,
        features: {
            features: {
                machines: {
                    enabled: true,
                    transfer: {
                        enabled: true,
                        serverRouted: { enabled: true },
                    },
                },
            },
            capabilities: {},
        },
    } as any,
}));

vi.mock('@/sync/domains/state/storage', () =>
    createStorageModuleStub({
        useSession: () => state.session,
    }),
);

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => state.machineReachability,
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: () => state.machineTarget,
}));

vi.mock('@/sync/domains/transfers/runtime/transferRouteCache', () => ({
    readCachedMachineRpcDirectRoute: () => state.cachedMachineRpcDirectRoute,
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesSnapshotForServerId: () => state.serverSnapshot,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: () => 'server-1',
}));

describe('useSessionFileDownloadAvailability', () => {
    it('reflects cached direct-route failures after rerender (no stale memoization)', async () => {
        state.session = { active: false } as any;
        state.machineReachability = { machineRpcTargetAvailable: true } as any;
        state.machineTarget = { machineId: 'machine-1', basePath: '/repo' } as any;
        state.cachedMachineRpcDirectRoute = { status: 'unknown' as const } as any;
        state.serverSnapshot = {
            status: 'ready' as const,
            features: {
                features: {
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            serverRouted: { enabled: true },
                        },
                    },
                },
                capabilities: {},
            },
        } as any;

        const { useSessionFileDownloadAvailability } = await import('./useSessionFileDownloadAvailability');
        const hook = await renderHook(() => useSessionFileDownloadAvailability('s1'));
        expect(hook.getCurrent()).toBe(true);

        state.cachedMachineRpcDirectRoute = { status: 'unavailable' as const, failureReason: 'machine_rpc_direct_unavailable' } as any;
        await hook.rerender();
        expect(hook.getCurrent()).toBe(false);
    });

    it('fails closed when server feature snapshot is not ready (even if a machine target exists)', async () => {
        state.session = { active: true } as any;
        state.machineReachability = { machineRpcTargetAvailable: true } as any;
        state.cachedMachineRpcDirectRoute = { status: 'unknown' as const };
        state.serverSnapshot = { status: 'loading' } as any;

        const { useSessionFileDownloadAvailability } = await import('./useSessionFileDownloadAvailability');
        const hook = await renderHook(() => useSessionFileDownloadAvailability('s1'));
        expect(hook.getCurrent()).toBe(false);
    });

    it('hides download actions when direct mode is unreachable and session RPC is unavailable', async () => {
        state.session = { active: false } as any;
        state.machineReachability = { machineRpcTargetAvailable: true } as any;
        state.machineTarget = { machineId: 'machine-1', basePath: '/repo' } as any;
        state.cachedMachineRpcDirectRoute = { status: 'unavailable' as const, failureReason: 'machine_rpc_direct_unavailable' } as any;
        state.serverSnapshot = {
            status: 'ready' as const,
            features: {
                features: {
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            serverRouted: { enabled: true },
                        },
                    },
                },
                capabilities: {},
            },
        } as any;

        const { useSessionFileDownloadAvailability } = await import('./useSessionFileDownloadAvailability');
        const hook = await renderHook(() => useSessionFileDownloadAvailability('s1'));
        expect(hook.getCurrent()).toBe(false);
    });
});
