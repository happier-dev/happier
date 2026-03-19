import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createEncryptedTransferChunkEnvelope } from './transferChunkEncryption';

const machineRPC = vi.fn();

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        machineRPC,
    },
}));

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: vi.fn(),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: () => undefined,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: vi.fn(),
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: () => ({ machineId: 'machine-1', basePath: '/repo' }),
    canUseSessionRpc: () => true,
    resolveMachinePathFromSessionBase: ({ basePath, requestPath }: { basePath: string; requestPath: string }) => `${basePath}/${requestPath}`,
    shouldFallbackToSessionRpc: () => false,
}));

afterEach(() => {
    machineRPC.mockReset();
});

describe('downloadSessionPathViaTransfer', () => {
    it('streams bytes through the shared transfer client and reports progress', async () => {
        let recipientPublicKeyBase64 = '';
        machineRPC.mockImplementation(async (_machineId: string, method: string, payload?: { recipientPublicKeyBase64?: string }) => {
            if (method === RPC_METHODS.FILES_DOWNLOAD_INIT) {
                recipientPublicKeyBase64 = payload?.recipientPublicKeyBase64 ?? '';
                return {
                    success: true,
                    downloadId: 'download-1',
                    chunkSizeBytes: 2,
                    sizeBytes: 5,
                    name: 'hello.txt',
                };
            }
            if (method === RPC_METHODS.FILES_DOWNLOAD_CHUNK) {
                const call = machineRPC.mock.calls.filter((entry) => entry[1] === RPC_METHODS.FILES_DOWNLOAD_CHUNK).length;
                if (call === 1) {
                    return {
                        success: true,
                        ...await createEncryptedTransferChunkEnvelope({
                            transferId: 'download-1',
                            sequence: 0,
                            payload: new TextEncoder().encode('he'),
                            recipientPublicKeyBase64,
                        }),
                        isLast: false,
                    };
                }
                if (call === 2) {
                    return {
                        success: true,
                        ...await createEncryptedTransferChunkEnvelope({
                            transferId: 'download-1',
                            sequence: 1,
                            payload: new TextEncoder().encode('ll'),
                            recipientPublicKeyBase64,
                        }),
                        isLast: false,
                    };
                }
                return {
                    success: true,
                    ...await createEncryptedTransferChunkEnvelope({
                        transferId: 'download-1',
                        sequence: 2,
                        payload: new TextEncoder().encode('o'),
                        recipientPublicKeyBase64,
                    }),
                    isLast: true,
                };
            }
            if (method === RPC_METHODS.FILES_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            throw new Error(`unexpected method ${method}`);
        });

        const writeBytes = vi.fn(async (_bytes: Uint8Array) => {});
        const onProgress = vi.fn();

        const { downloadSessionPathViaTransfer } = await import('./sessionPathTransferRpc');

        const result = await downloadSessionPathViaTransfer({
            sessionId: 'session-1',
            path: 'hello.txt',
            writeBytes,
            onProgress,
        });

        expect(result).toEqual({
            success: true,
            name: 'hello.txt',
            sizeBytes: 5,
        });
        expect(writeBytes.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes))).toEqual(['he', 'll', 'o']);
        expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
            { downloadedBytes: 2, totalBytes: 5 },
            { downloadedBytes: 4, totalBytes: 5 },
            { downloadedBytes: 5, totalBytes: 5 },
        ]);
    });
});
