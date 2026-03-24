import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
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
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdMock(sessionId),
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: (sessionId: string) => readMachineTargetForSessionMock(sessionId),
    canUseSessionRpc: (sessionId: string) => canUseSessionRpcMock(sessionId),
    shouldFallbackToSessionRpc: (sessionId: string, error: unknown) =>
        shouldFallbackToSessionRpcMock(sessionId, error),
}));

import { createSessionFileTransferRpcCaller, INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR } from './sessionFileTransferRpcCaller';

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
    shouldFallbackToSessionRpcMock.mockImplementation(
        (_sessionId: string, error: unknown) =>
            (error as { rpcErrorCode?: string } | null)?.rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    );
});

describe('sessionFileTransferRpcCaller', () => {
    it('consults shared transfer policy before each allowed direct machine rpc attempt', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        getReadyServerFeaturesMock.mockResolvedValue(createServerFeatures());
        machineRPC.mockResolvedValue({ success: true, value: 'ok' });

        const caller = createSessionFileTransferRpcCaller({ sessionId: 'session-1' });

        await expect(
            caller.call({
                request: { t: 'session_file_upload_v1', path: 'first.txt', sizeBytes: 1 },
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT,
                sessionMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT,
                toMachineRequest: ({ request, machineTarget }) => ({
                    ...request,
                    path: `${machineTarget.basePath}/${request.path}`,
                }),
            }),
        ).resolves.toEqual({ success: true, value: 'ok' });

        await expect(
            caller.call({
                request: { t: 'session_file_upload_v1', path: 'second.txt', sizeBytes: 1 },
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT,
                sessionMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT,
                toMachineRequest: ({ request, machineTarget }) => ({
                    ...request,
                    path: `${machineTarget.basePath}/${request.path}`,
                }),
            }),
        ).resolves.toEqual({ success: true, value: 'ok' });

        expect(machineRPC).toHaveBeenCalledTimes(2);
        expect(machineRPC).toHaveBeenNthCalledWith(1, 'machine-1', RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT, { t: 'session_file_upload_v1', path: '/repo/first.txt', sizeBytes: 1 });
        expect(machineRPC).toHaveBeenNthCalledWith(2, 'machine-1', RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT, { t: 'session_file_upload_v1', path: '/repo/second.txt', sizeBytes: 1 });
        // Policy must be consulted before any direct machine RPC attempt. Depending on how the runtime composes
        // route selection and direct-route guarding, this may involve one or more feature reads per call.
        expect(getReadyServerFeaturesMock.mock.calls.length).toBeGreaterThanOrEqual(2);
        for (const [params] of getReadyServerFeaturesMock.mock.calls) {
            expect(params).toEqual({ timeoutMs: 500, serverId: 'server-owned' });
        }
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('goes straight to session RPC when no direct machine target is available', async () => {
        readMachineTargetForSessionMock.mockReturnValue(null);
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        getReadyServerFeaturesMock.mockResolvedValue(null);
        sessionRpcWithServerScopeMock.mockResolvedValue({ success: true, value: 'relayed' });

        const caller = createSessionFileTransferRpcCaller({ sessionId: 'session-1' });

        await expect(
            caller.call({
                request: { path: 'hello.txt' },
                machineMethod: 'machine.download',
                sessionMethod: 'session.download',
            }),
        ).resolves.toEqual({ success: true, value: 'relayed' });

        expect(machineRPC).not.toHaveBeenCalled();
        expect(getReadyServerFeaturesMock).toHaveBeenCalledWith({ timeoutMs: 500, serverId: 'server-owned' });
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-owned',
            method: 'session.download',
            payload: { path: 'hello.txt' },
        });
    });

    it('returns non-fallback machine errors instead of relaying through session RPC', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        getReadyServerFeaturesMock.mockResolvedValue(createServerFeatures());
        shouldFallbackToSessionRpcMock.mockReturnValue(false);
        machineRPC.mockRejectedValue({ message: 'machine exploded', rpcErrorCode: 'custom_error' });

        const caller = createSessionFileTransferRpcCaller({ sessionId: 'session-1' });

        await expect(
            caller.call({
                request: { path: 'broken.txt' },
                machineMethod: 'machine.upload',
                sessionMethod: 'session.upload',
            }),
        ).resolves.toEqual({
            success: false,
            error: 'machine exploded',
            errorCode: 'custom_error',
        });

        expect(getReadyServerFeaturesMock).toHaveBeenCalledWith({ timeoutMs: 500, serverId: 'server-owned' });
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('fails closed when no direct machine target exists and session RPC is unavailable', async () => {
        readMachineTargetForSessionMock.mockReturnValue(null);
        canUseSessionRpcMock.mockReturnValue(false);
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        getReadyServerFeaturesMock.mockResolvedValue(null);

        const caller = createSessionFileTransferRpcCaller({ sessionId: 'session-1' });

        await expect(
            caller.call({
                request: { path: 'missing.txt' },
                machineMethod: 'machine.download',
                sessionMethod: 'session.download',
            }),
        ).resolves.toEqual({
            success: false,
            error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });

        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('does not attempt machine rpc when shared transfer policy disables machine transfer', async () => {
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

        const caller = createSessionFileTransferRpcCaller({ sessionId: 'session-1' });

        await expect(
            caller.call({
                request: { path: 'blocked.txt' },
                machineMethod: 'machine.upload',
                sessionMethod: 'session.upload',
            }),
        ).resolves.toEqual({
            success: false,
            error: 'Server-routed transfer is disabled on the selected server',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });

        expect(machineRPC).not.toHaveBeenCalled();
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('does not attempt machine rpc when shared transfer policy rejects the payload as too large', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        getReadyServerFeaturesMock.mockResolvedValue(createServerFeatures({
            capabilities: {
                machines: {
                    transfer: {
                        serverRouted: {
                            maxBytes: 4,
                        },
                    },
                },
            },
        }));

        const caller = createSessionFileTransferRpcCaller({
            sessionId: 'session-1',
            sessionRpcTransferSizeBytes: 5,
        });

        await expect(
            caller.call({
                request: { path: 'oversized.txt' },
                machineMethod: 'machine.upload',
                sessionMethod: 'session.upload',
            }),
        ).resolves.toEqual({
            success: false,
            error: 'File exceeds the server-routed transfer size limit',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });

        expect(machineRPC).not.toHaveBeenCalled();
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

});
