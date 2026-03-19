import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { FeaturesResponse } from '@happier-dev/protocol';

const machineRPC = vi.fn();
const sessionRpcWithServerScope = vi.fn();
const getReadyServerFeaturesMock = vi.fn<(params: unknown) => Promise<FeaturesResponse | null>>();
const resolvePreferredServerIdForSessionIdMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        machineRPC,
    },
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: (params: unknown) => sessionRpcWithServerScope(params),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdMock(sessionId),
}));
vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: (params: unknown) => getReadyServerFeaturesMock(params),
}));
vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: () => ({ machineId: 'machine-1', basePath: '/repo' }),
    canUseSessionRpc: () => true,
    resolveMachinePathFromSessionBase: ({ basePath, requestPath }: { basePath: string; requestPath: string }) => `${basePath}/${requestPath}`,
    shouldFallbackToSessionRpc: (_sessionId: string, error: unknown) =>
        (error as { rpcErrorCode?: string }).rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
}));

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    machineRPC.mockReset();
    sessionRpcWithServerScope.mockReset();
    getReadyServerFeaturesMock.mockReset();
    resolvePreferredServerIdForSessionIdMock.mockReset();
});

describe('sessionPathTransferRpc upload fallback', () => {
    it('falls back to session RPC for abort when machine RPC is unavailable', async () => {
        const unavailableError = {
            rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            message: 'Method not available',
        };
        machineRPC.mockRejectedValue(unavailableError);
        sessionRpcWithServerScope.mockResolvedValue({ success: true });
        getReadyServerFeaturesMock.mockResolvedValue({
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
        } as FeaturesResponse);
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');

        const { createSessionFilesUploadTransferClient } = await import('./sessionPathTransferRpc');
        const client = createSessionFilesUploadTransferClient({ sessionId: 'session-1', sizeBytes: 1 });

        await expect(client.abort({ uploadId: 'upload-1' })).resolves.toEqual({ success: true });

        expect(getReadyServerFeaturesMock).toHaveBeenCalledWith({ timeoutMs: 500, serverId: 'server-owned' });
        expect(sessionRpcWithServerScope).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-owned',
            method: RPC_METHODS.FILES_UPLOAD_ABORT,
            payload: { uploadId: 'upload-1' },
        });
    });

    it('keeps session RPC fallback available when selected server features are unavailable', async () => {
        const unavailableError = {
            rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            message: 'Method not available',
        };
        machineRPC.mockRejectedValue(unavailableError);
        sessionRpcWithServerScope.mockResolvedValue({ success: true });
        getReadyServerFeaturesMock.mockResolvedValue(null);
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');

        const { createSessionFilesUploadTransferClient } = await import('./sessionPathTransferRpc');
        const client = createSessionFilesUploadTransferClient({ sessionId: 'session-1', sizeBytes: 1 });

        await expect(client.abort({ uploadId: 'upload-1' })).resolves.toEqual({ success: true });

        expect(getReadyServerFeaturesMock).toHaveBeenCalledWith({ timeoutMs: 500, serverId: 'server-owned' });
        expect(sessionRpcWithServerScope).toHaveBeenCalledTimes(1);
    });

    it('fails closed before upload init session RPC fallback when the selected server max-bytes policy is exceeded', async () => {
        const unavailableError = {
            rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            message: 'Method not available',
        };
        machineRPC.mockRejectedValue(unavailableError);
        sessionRpcWithServerScope.mockResolvedValue({ success: true });
        getReadyServerFeaturesMock.mockResolvedValue({
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
                            maxBytes: 4,
                        },
                    },
                },
            },
        } as FeaturesResponse);
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');

        const { createSessionFilesUploadTransferClient } = await import('./sessionPathTransferRpc');
        const client = createSessionFilesUploadTransferClient({ sessionId: 'session-1', sizeBytes: 5 });

        await expect(client.init({ path: 'large.bin', sizeBytes: 5 })).resolves.toEqual({
            success: false,
            error: 'File exceeds the server-routed transfer size limit',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });

    expect(getReadyServerFeaturesMock).toHaveBeenCalledWith({ timeoutMs: 500, serverId: 'server-owned' });
    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
  });

    it('locks session RPC fallback after init so later upload calls reuse the same route without refetching server features', async () => {
        const unavailableError = {
            rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            message: 'Method not available',
        };
        machineRPC.mockRejectedValueOnce(unavailableError);
        sessionRpcWithServerScope
            .mockResolvedValueOnce({
                success: true,
                uploadId: 'upload-1',
                chunkSizeBytes: 4,
                recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            })
            .mockResolvedValueOnce({ success: true });
        getReadyServerFeaturesMock.mockResolvedValue({
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
        } as FeaturesResponse);
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');

        const { createSessionFilesUploadTransferClient } = await import('./sessionPathTransferRpc');

        const client = createSessionFilesUploadTransferClient({ sessionId: 'session-1', sizeBytes: 3 });

        await expect(client.init({ path: 'hello.txt', sizeBytes: 3 })).resolves.toEqual({
            success: true,
            uploadId: 'upload-1',
            chunkSizeBytes: 4,
            recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
        });
        await expect(client.chunk({
            uploadId: 'upload-1',
            index: 0,
            payloadBase64: 'Zm9v',
            encryptedDataKeyEnvelopeBase64: 'ZW52',
        })).resolves.toEqual({
            success: true,
        });

        expect(machineRPC).toHaveBeenCalledTimes(1);
        expect(getReadyServerFeaturesMock).toHaveBeenCalledTimes(1);
        expect(sessionRpcWithServerScope).toHaveBeenCalledTimes(2);
    });

    it('suppresses an immediate retry of machine RPC on the next upload call after a fallback-eligible direct failure', async () => {
        const unavailableError = {
            rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            message: 'Method not available',
        };
        machineRPC.mockRejectedValue(unavailableError);
        sessionRpcWithServerScope.mockResolvedValue({ success: true });
        getReadyServerFeaturesMock.mockResolvedValue({
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
        } as FeaturesResponse);
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');

        const { createSessionFilesUploadTransferClient } = await import('./sessionPathTransferRpc');
        const client = createSessionFilesUploadTransferClient({ sessionId: 'session-1', sizeBytes: 1 });

        await expect(client.abort({ uploadId: 'upload-1' })).resolves.toEqual({ success: true });
        await expect(client.abort({ uploadId: 'upload-2' })).resolves.toEqual({ success: true });

        expect(machineRPC).toHaveBeenCalledTimes(1);
        expect(sessionRpcWithServerScope).toHaveBeenCalledTimes(2);
    });
});
