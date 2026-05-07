import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { FeaturesResponse } from '@happier-dev/protocol';

const {
    machineRPC,
    machineRpcWithServerScopeMock,
    sessionRpcWithServerScopeMock,
    getReadyServerFeaturesMock,
    resolvePreferredServerIdForSessionIdMock,
    readMachineTargetForSessionMock,
    canUseSessionRpcMock,
    shouldFallbackToSessionRpcMock,
} = vi.hoisted(() => ({
    machineRPC: vi.fn(),
    machineRpcWithServerScopeMock: vi.fn(),
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

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScopeMock(params),
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

import {
    INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
    callSessionMachineRpcWithFallback,
    createSessionMachineRpcFallbackCaller,
    resolveDefaultSessionRpcFallbackRoute,
} from './sessionMachineRpcFallback';

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
    machineRpcWithServerScopeMock.mockReset();
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
    it('propagates timeoutMs when using the callSessionMachineRpcWithFallback wrapper', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        getReadyServerFeaturesMock.mockResolvedValue(createServerFeatures());

        machineRPC.mockResolvedValue({ success: true, value: 'direct' });

        const result = await (
            callSessionMachineRpcWithFallback as unknown as (params: any) => Promise<unknown>
        )({
            sessionId: 'session-1',
            request: { path: 'hello.txt' },
            machineMethod: RPC_METHODS.STAT_FILE,
            sessionMethod: RPC_METHODS.STAT_FILE,
            resolveFallbackRoute: async () => ({
                kind: 'selected',
                route: {
                    kind: 'server_routed_stream',
                    serverId: 'server-owned',
                },
            }),
            timeoutMs: 1234,
        });

        expect(result).toEqual({ success: true, value: 'direct' });
        expect(machineRPC).toHaveBeenCalledWith(
            'machine-1',
            RPC_METHODS.STAT_FILE,
            { path: 'hello.txt' },
            { timeoutMs: 1234 },
        );
    });

    it('propagates timeoutMs to direct machine RPC calls', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        getReadyServerFeaturesMock.mockResolvedValue(createServerFeatures());

        machineRPC.mockResolvedValue({ success: true, value: 'direct' });

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
            machineMethod: RPC_METHODS.STAT_FILE,
            sessionMethod: RPC_METHODS.STAT_FILE,
            timeoutMs: 1234,
        })).resolves.toEqual({ success: true, value: 'direct' });

        expect(machineRPC).toHaveBeenCalledWith(
            'machine-1',
            RPC_METHODS.STAT_FILE,
            { path: 'hello.txt' },
            { timeoutMs: 1234 },
        );
    });

    it('propagates timeoutMs to server-scoped fallbacks for guarded methods', async () => {
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

        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, value: 'relayed' });

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
            timeoutMs: 4321,
        })).resolves.toEqual({ success: true, value: 'relayed' });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-owned',
            method: RPC_METHODS.LIST_DIRECTORY,
            payload: { path: 'hello.txt' },
            preferScoped: true,
            timeoutMs: 4321,
        });
    });

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
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, value: 'relayed' });

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
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-owned',
            method: RPC_METHODS.LIST_DIRECTORY,
            payload: { path: 'hello.txt' },
            preferScoped: true,
        });
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('fails closed (no machine_rpc_direct) for all sessionFileSystem methods when server features are unavailable', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        getReadyServerFeaturesMock.mockResolvedValue(null);

        machineRPC.mockResolvedValue({ success: true, value: 'direct' });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, value: 'relayed' });

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

        const methods = [
            RPC_METHODS.CREATE_DIRECTORY,
            RPC_METHODS.LIST_DIRECTORY,
            RPC_METHODS.GET_DIRECTORY_TREE,
            RPC_METHODS.STAT_FILE,
            RPC_METHODS.RENAME_PATH,
            RPC_METHODS.DELETE_PATH,
            RPC_METHODS.WRITE_FILE,
        ] as const;

        for (const method of methods) {
            await expect(caller.call({
                request: { path: 'hello.txt', content: 'Zm9v', from: 'a', to: 'b' },
                machineMethod: method,
                sessionMethod: method,
            })).resolves.toEqual({ success: true, value: 'relayed' });
        }

        // If any of these methods were not policy-guarded, the caller would attempt
        // `apiSocket.machineRPC` even though server feature policy cannot be evaluated.
        expect(machineRPC).not.toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(methods.length);
        expect(getReadyServerFeaturesMock).toHaveBeenCalledTimes(methods.length);
        expect(getReadyServerFeaturesMock).toHaveBeenNthCalledWith(1, { timeoutMs: 500, serverId: 'server-owned' });
    });

    it('fails closed (no machine_rpc_direct) for guarded methods when server features are not available yet', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        getReadyServerFeaturesMock.mockResolvedValue(null);

        machineRPC.mockResolvedValue({ success: true, value: 'direct' });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, value: 'relayed' });

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
            request: { path: 'hello.txt', content: 'Zm9v' },
            machineMethod: RPC_METHODS.WRITE_FILE,
            sessionMethod: RPC_METHODS.WRITE_FILE,
        })).resolves.toEqual({ success: true, value: 'relayed' });

        expect(machineRPC).not.toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-owned',
            method: RPC_METHODS.WRITE_FILE,
            payload: { path: 'hello.txt', content: 'Zm9v' },
            preferScoped: true,
        });
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('uses server-scoped machine RPC for guarded methods when session RPC is unavailable', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo' });
        canUseSessionRpcMock.mockReturnValue(false);
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        getReadyServerFeaturesMock.mockResolvedValue(null);

        machineRPC.mockResolvedValue({ success: true, value: 'direct' });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, value: 'relayed' });

        const caller = createSessionMachineRpcFallbackCaller({
            sessionId: 'session-1',
            resolveFallbackRoute: async () => resolveDefaultSessionRpcFallbackRoute({
                sessionId: 'session-1',
                inactiveResponse: {
                    success: false,
                    error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
                    errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
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
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-owned',
            method: RPC_METHODS.LIST_DIRECTORY,
            payload: { path: 'hello.txt' },
            preferScoped: true,
        });
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('fails closed (no machine_rpc_direct) for guarded methods when server features evaluation throws', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        getReadyServerFeaturesMock.mockRejectedValueOnce(new Error('features not ready'));

        machineRPC.mockResolvedValue({ success: true, value: 'direct' });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, value: 'relayed' });

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
            request: { path: 'hello.txt', content: 'Zm9v' },
            machineMethod: RPC_METHODS.WRITE_FILE,
            sessionMethod: RPC_METHODS.WRITE_FILE,
        })).resolves.toEqual({ success: true, value: 'relayed' });

        expect(machineRPC).not.toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-owned',
            method: RPC_METHODS.WRITE_FILE,
            payload: { path: 'hello.txt', content: 'Zm9v' },
            preferScoped: true,
        });
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('re-checks shared transfer policy even when a direct route is cached (reuseResolvedRoute)', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');

        const transferEnabled = createServerFeatures();
        const transferDisabled = createServerFeatures({
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
        });
        // 1) First call allows direct route.
        // 2) Second call checks the cached direct route (disabled) and then checks again before a new direct attempt (disabled).
        getReadyServerFeaturesMock
            .mockResolvedValueOnce(transferEnabled)
            .mockResolvedValueOnce(transferDisabled)
            .mockResolvedValueOnce(transferDisabled);

        machineRPC.mockResolvedValue({ success: true, value: 'direct' });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, value: 'relayed' });

        const caller = createSessionMachineRpcFallbackCaller({
            sessionId: 'session-1',
            resolveFallbackRoute: async () => ({
                kind: 'selected',
                route: {
                    kind: 'server_routed_stream',
                    serverId: 'server-owned',
                },
            }),
            reuseResolvedRoute: true,
        });

        await expect(caller.call({
            request: { path: 'hello.txt' },
            machineMethod: RPC_METHODS.LIST_DIRECTORY,
            sessionMethod: RPC_METHODS.LIST_DIRECTORY,
        })).resolves.toEqual({ success: true, value: 'direct' });

        await expect(caller.call({
            request: { path: 'hello.txt' },
            machineMethod: RPC_METHODS.LIST_DIRECTORY,
            sessionMethod: RPC_METHODS.LIST_DIRECTORY,
        })).resolves.toEqual({ success: true, value: 'relayed' });

        expect(machineRPC).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(getReadyServerFeaturesMock).toHaveBeenCalledTimes(3);

        // Policy evaluation must happen before the direct attempt on the first call.
        expect(getReadyServerFeaturesMock.mock.invocationCallOrder[0]).toBeLessThan(machineRPC.mock.invocationCallOrder[0]);
    });
});
