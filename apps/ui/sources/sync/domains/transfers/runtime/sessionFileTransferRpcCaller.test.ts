import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
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
    it('locks a successful direct machine route and reuses it without consulting session fallback state', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo' });
        machineRPC.mockResolvedValue({ success: true, value: 'ok' });

        const caller = createSessionFileTransferRpcCaller({ sessionId: 'session-1' });

        await expect(
            caller.call({
                request: { path: 'first.txt' },
                machineMethod: 'machine.upload',
                sessionMethod: 'session.upload',
                toMachineRequest: ({ request, machineTarget }) => ({
                    ...request,
                    path: `${machineTarget.basePath}/${request.path}`,
                }),
            }),
        ).resolves.toEqual({ success: true, value: 'ok' });

        await expect(
            caller.call({
                request: { path: 'second.txt' },
                machineMethod: 'machine.upload',
                sessionMethod: 'session.upload',
                toMachineRequest: ({ request, machineTarget }) => ({
                    ...request,
                    path: `${machineTarget.basePath}/${request.path}`,
                }),
            }),
        ).resolves.toEqual({ success: true, value: 'ok' });

        expect(machineRPC).toHaveBeenCalledTimes(2);
        expect(machineRPC).toHaveBeenNthCalledWith(1, 'machine-1', 'machine.upload', { path: '/repo/first.txt' });
        expect(machineRPC).toHaveBeenNthCalledWith(2, 'machine-1', 'machine.upload', { path: '/repo/second.txt' });
        expect(getReadyServerFeaturesMock).not.toHaveBeenCalled();
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

        expect(getReadyServerFeaturesMock).not.toHaveBeenCalled();
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

});
