import { FeaturesResponseSchema, type FeaturesResponse } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { installPartialStorageModuleMock } from '@/dev/testkit/mocks/storage';

const machineRpcTargetAvailableState = { value: true };
const cachedDirectRouteStatusState = { value: 'unknown' as 'unknown' | 'viable' | 'unavailable' };

function createServerFeaturesResponse(partial?: Readonly<{
    features?: unknown;
    capabilities?: unknown;
}>): FeaturesResponse {
    return FeaturesResponseSchema.parse({
        features: {
            machines: {
                enabled: true,
                transfer: {
                    enabled: true,
                    directPeer: {
                        enabled: false,
                    },
                    serverRouted: {
                        enabled: false,
                    },
                },
            },
            ...(partial?.features ?? {}),
        },
        capabilities: {
            ...(partial?.capabilities ?? {}),
        },
    });
}

vi.mock('@/sync/domains/state/storage', async (importOriginal) =>
    installPartialStorageModuleMock({
        useSession: () => ({ active: true }),
    })(importOriginal),
);

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({
        machineReachable: true,
        machineOnline: true,
        machineRpcTargetAvailable: machineRpcTargetAvailableState.value,
    }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: () => 'server-1',
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesSnapshotForServerId: () => ({
        status: 'ready',
        features: createServerFeaturesResponse({
            features: {
                machines: {
                    enabled: true,
                    transfer: {
                        enabled: true,
                        serverRouted: { enabled: false },
                    },
                },
            },
        }),
    }),
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: () => ({
        machineId: 'machine-1',
        basePath: '/tmp',
    }),
}));

vi.mock('@/sync/domains/transfers/runtime/transferRouteCache', () => ({
    readCachedMachineRpcDirectRoute: () => ({
        status: cachedDirectRouteStatusState.value,
        checkedAt: 0,
        expiresAt: 0,
        failureReason: cachedDirectRouteStatusState.value === 'unavailable' ? 'nope' : undefined,
    }),
}));

describe('useSessionFileDownloadAvailability', () => {
    it('fails closed when server-routed is disabled and machine-rpc-direct viability is unknown', async () => {
        cachedDirectRouteStatusState.value = 'unknown';
        machineRpcTargetAvailableState.value = true;

        const { useSessionFileDownloadAvailability } = await import('./useSessionFileDownloadAvailability');
        const hook = await renderHook(() => useSessionFileDownloadAvailability('session-1'));

        expect(hook.getCurrent()).toBe(false);
        await hook.unmount();
    });

    it('returns true when server-routed is disabled and machine-rpc-direct is confirmed viable', async () => {
        cachedDirectRouteStatusState.value = 'viable';
        machineRpcTargetAvailableState.value = true;

        const { useSessionFileDownloadAvailability } = await import('./useSessionFileDownloadAvailability');
        const hook = await renderHook(() => useSessionFileDownloadAvailability('session-1'));

        expect(hook.getCurrent()).toBe(true);
        await hook.unmount();
    });

    it('upload fails closed when server-routed is disabled and machine-rpc-direct viability is unknown', async () => {
        cachedDirectRouteStatusState.value = 'unknown';
        machineRpcTargetAvailableState.value = true;

        const { useSessionFileUploadAvailability } = await import('./useSessionFileUploadAvailability');
        const hook = await renderHook(() => useSessionFileUploadAvailability('session-1'));

        expect(hook.getCurrent()).toBe(false);
        await hook.unmount();
    });

    it('upload returns true when server-routed is disabled and machine-rpc-direct is confirmed viable', async () => {
        cachedDirectRouteStatusState.value = 'viable';
        machineRpcTargetAvailableState.value = true;

        const { useSessionFileUploadAvailability } = await import('./useSessionFileUploadAvailability');
        const hook = await renderHook(() => useSessionFileUploadAvailability('session-1'));

        expect(hook.getCurrent()).toBe(true);
        await hook.unmount();
    });
});
