import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    session: { active: true } as any,
    machineReachability: { machineRpcTargetAvailable: true } as any,
    machineTarget: { machineId: 'machine-1', basePath: '/repo' } as any,
    cachedMachineRpcDirectRoute: { status: 'viable' as const } as any,
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
            capabilities: {
                machines: {
                    transfer: {
                        serverRouted: {
                            maxBytes: 128,
                        },
                    },
                },
            },
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

describe('useSessionFileTransferAvailabilityResolver', () => {
    it('fails closed for oversized transfers based on the server transfer policy snapshot', async () => {
        const { useSessionFileTransferAvailabilityResolver } = await import('./useSessionFileTransferAvailability');
        const hook = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1'));

        expect(hook.getCurrent()(64)).toBe(true);
        expect(hook.getCurrent()(512)).toBe(false);
    });

    it('fails closed when the session record is missing (no speculative transfer availability)', async () => {
        state.session = null as any;
        state.machineReachability = { machineRpcTargetAvailable: true } as any;
        state.machineTarget = { machineId: 'machine-1', basePath: '/repo' } as any;
        state.cachedMachineRpcDirectRoute = { status: 'viable' as const } as any;
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

        const { useSessionFileTransferAvailabilityResolver } = await import('./useSessionFileTransferAvailability');
        const hook = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1'));

        expect(hook.getCurrent()(null)).toBe(false);
    });
});
