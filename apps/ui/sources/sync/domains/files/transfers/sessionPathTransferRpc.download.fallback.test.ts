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

describe('sessionPathTransferRpc download fallback', () => {
    it('falls back to session RPC for finalize and abort when machine RPC is unavailable', async () => {
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

        const { createSessionFilesDownloadTransferClient } = await import('./sessionPathTransferRpc');
        const client = createSessionFilesDownloadTransferClient({ sessionId: 'session-1' });

        await expect(client.finalize({ downloadId: 'download-1' })).resolves.toEqual({ success: true });
        await expect(client.abort({ downloadId: 'download-1' })).resolves.toEqual({ success: true });

        expect(getReadyServerFeaturesMock).toHaveBeenCalledWith({ timeoutMs: 500, serverId: 'server-owned' });
        expect(sessionRpcWithServerScope).toHaveBeenNthCalledWith(1, {
            sessionId: 'session-1',
            serverId: 'server-owned',
            method: RPC_METHODS.FILES_DOWNLOAD_FINALIZE,
            payload: { downloadId: 'download-1' },
        });
        expect(sessionRpcWithServerScope).toHaveBeenNthCalledWith(2, {
            sessionId: 'session-1',
            serverId: 'server-owned',
            method: RPC_METHODS.FILES_DOWNLOAD_ABORT,
            payload: { downloadId: 'download-1' },
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

        const { createSessionFilesDownloadTransferClient } = await import('./sessionPathTransferRpc');
        const client = createSessionFilesDownloadTransferClient({ sessionId: 'session-1' });

        await expect(client.abort({ downloadId: 'download-1' })).resolves.toEqual({ success: true });

        expect(getReadyServerFeaturesMock).toHaveBeenCalledWith({ timeoutMs: 500, serverId: 'server-owned' });
        expect(sessionRpcWithServerScope).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-owned',
            method: RPC_METHODS.FILES_DOWNLOAD_ABORT,
            payload: { downloadId: 'download-1' },
        });
    });

    it('locks session RPC fallback after init so later download calls reuse the same route without refetching server features', async () => {
        const unavailableError = {
            rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            message: 'Method not available',
        };
        machineRPC.mockRejectedValueOnce(unavailableError);
        sessionRpcWithServerScope
            .mockResolvedValueOnce({
                success: true,
                downloadId: 'download-1',
                chunkSizeBytes: 4,
                sizeBytes: 3,
                name: 'hello.txt',
            })
            .mockResolvedValueOnce({
                success: true,
                payloadBase64: 'Zm9v',
                encryptedDataKeyEnvelopeBase64: 'ZW52',
                isLast: true,
            });
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

        const { createSessionFilesDownloadTransferClient } = await import('./sessionPathTransferRpc');

        const client = createSessionFilesDownloadTransferClient({ sessionId: 'session-1' });

        await expect(client.init({
            path: 'hello.txt',
            recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
        })).resolves.toEqual({
            success: true,
            downloadId: 'download-1',
            chunkSizeBytes: 4,
            sizeBytes: 3,
            name: 'hello.txt',
        });
        await expect(client.chunk({ downloadId: 'download-1', index: 0 })).resolves.toEqual({
            success: true,
            payloadBase64: 'Zm9v',
            encryptedDataKeyEnvelopeBase64: 'ZW52',
            isLast: true,
        });

        expect(machineRPC).toHaveBeenCalledTimes(1);
        expect(getReadyServerFeaturesMock).toHaveBeenCalledTimes(1);
        expect(sessionRpcWithServerScope).toHaveBeenCalledTimes(2);
    });
});
