import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const bulkUploadMock = vi.hoisted(() => vi.fn());
const callerCallMock = vi.hoisted(() => vi.fn());

vi.mock('./uploadBulkPayloadFromFile', () => ({
    uploadBulkPayloadFromFile: (...args: unknown[]) => bulkUploadMock(...args),
}));

vi.mock('./workspaceFileTransferRpcCaller', () => ({
    createWorkspaceFileTransferRpcCaller: () => ({
        call: (...args: unknown[]) => callerCallMock(...args),
    }),
}));

describe('daemonWorkspaceFiles upload', () => {
    it('routes workspace uploads through the shared workspace transfer caller', async () => {
        bulkUploadMock.mockImplementation(async (params: any) => {
            expect(params.fileReader.sizeBytes).toBe(5);
            await params.fileReader.readBytes(0, 5);
            return {
                success: true,
                path: '/repo/payload.bin',
                sizeBytes: 5,
                sha256: 'sha256:test',
            };
        });
        callerCallMock.mockImplementation(async (params: any) => {
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT) {
                return {
                    success: true,
                    uploadId: 'bulk-upload-1',
                    chunkSizeBytes: 5,
                    recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
                };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK) {
                return { success: true };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE) {
                return { success: true, path: '/repo/payload.bin', sizeBytes: 5, sha256: 'sha256:test' };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_ABORT) {
                return { success: true };
            }
            throw new Error(`unexpected method: ${params.machineMethod}`);
        });

        const { uploadDaemonWorkspaceFileFromReader } = await import('../transferSubstrate/workspaceFileTransfers');

        const result = await uploadDaemonWorkspaceFileFromReader({
            machineId: 'machine-1',
            serverId: 'server-1',
            rootPath: '/repo',
            fileReader: {
                sizeBytes: 5,
                readBytes: async (offset, length) => new TextEncoder().encode('hello').subarray(offset, offset + length),
                close: async () => {},
            },
            request: {
                path: 'payload.bin',
                sizeBytes: 5,
                overwrite: true,
            },
        });

        expect(result).toEqual({
            success: true,
            path: '/repo/payload.bin',
            sizeBytes: 5,
            sha256: 'sha256:test',
        });
        expect(bulkUploadMock).toHaveBeenCalledTimes(1);
    });
});
