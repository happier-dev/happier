import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { FeaturesResponse } from '@happier-dev/protocol';

const {
    machineRPC,
    sessionRpcWithServerScopeMock,
    getReadyServerFeaturesMock,
    resolvePreferredServerIdForSessionIdMock,
    readMachineTargetForSessionMock,
    canUseSessionRpcMock,
    shouldFallbackToSessionRpcMock,
} = vi.hoisted(() => ({
    machineRPC: vi.fn(),
    sessionRpcWithServerScopeMock: vi.fn(),
    getReadyServerFeaturesMock: vi.fn<(params: unknown) => Promise<FeaturesResponse | null>>(),
    resolvePreferredServerIdForSessionIdMock: vi.fn<(sessionId: string) => string | undefined>(),
    readMachineTargetForSessionMock: vi.fn(),
    canUseSessionRpcMock: vi.fn(),
    shouldFallbackToSessionRpcMock: vi.fn(),
}));

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        machineRPC,
    },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: (params: unknown) => sessionRpcWithServerScopeMock(params),
}));

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: (params: unknown) => getReadyServerFeaturesMock(params),
    getCachedReadyServerFeatures: () => null,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdMock(sessionId),
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: (sessionId: string) => readMachineTargetForSessionMock(sessionId),
    canUseSessionRpc: (sessionId: string) => canUseSessionRpcMock(sessionId),
    shouldFallbackToSessionRpc: (sessionId: string, error: unknown) =>
        shouldFallbackToSessionRpcMock(sessionId, error),
    resolveMachinePathFromSessionBase: ({ basePath, requestPath }: { basePath: string; requestPath?: string }) =>
        requestPath ? `${basePath}/${requestPath}` : basePath,
}));

import { createSessionMachineRpcFallbackCaller } from './sessionMachineRpcFallback';

function createServerFeatures(partial?: Readonly<{
    features?: unknown;
    capabilities?: unknown;
}>): FeaturesResponse {
    return {
        features: {
            machines: {
                enabled: true,
                transfer: {
                    enabled: true,
                    serverRouted: {
                        enabled: true,
                    },
                },
            },
            ...(partial?.features as object | undefined ?? {}),
        },
        capabilities: {
            ...(partial?.capabilities as object | undefined ?? {}),
        },
    } as FeaturesResponse;
}

afterEach(() => {
    machineRPC.mockReset();
    sessionRpcWithServerScopeMock.mockReset();
    getReadyServerFeaturesMock.mockReset();
    resolvePreferredServerIdForSessionIdMock.mockReset();
    readMachineTargetForSessionMock.mockReset();
    canUseSessionRpcMock.mockReset();
    shouldFallbackToSessionRpcMock.mockReset();

    canUseSessionRpcMock.mockReturnValue(true);
    shouldFallbackToSessionRpcMock.mockReturnValue(true);
});

describe('sessionMachineRpcFallback', () => {
    it('does not attempt direct machine RPC for guarded file-system methods when shared policy disables machine transfer', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        getReadyServerFeaturesMock.mockResolvedValue(createServerFeatures({
            features: {
                machines: {
                    enabled: true,
                    transfer: {
                        enabled: false,
                        serverRouted: {
                            enabled: true,
                        },
                    },
                },
            },
        }));

        machineRPC.mockResolvedValue({ success: true, value: 'direct' });
        sessionRpcWithServerScopeMock.mockResolvedValue({ success: true, value: 'relayed' });

        const caller = createSessionMachineRpcFallbackCaller({
            sessionId: 'session-1',
            resolveFallbackRoute: async () => ({
                kind: 'selected',
                route: {
                    kind: 'server_routed_stream',
                    serverId: 'server-owned',
                },
            }),
            reuseResolvedRoute: false,
        });

        await expect(caller.call({
            request: { path: 'hello.txt' },
            machineMethod: RPC_METHODS.LIST_DIRECTORY,
            sessionMethod: RPC_METHODS.LIST_DIRECTORY,
        })).resolves.toEqual({ success: true, value: 'relayed' });

        expect(machineRPC).not.toHaveBeenCalled();
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-owned',
            method: RPC_METHODS.LIST_DIRECTORY,
            payload: { path: 'hello.txt' },
        });
    });
});

