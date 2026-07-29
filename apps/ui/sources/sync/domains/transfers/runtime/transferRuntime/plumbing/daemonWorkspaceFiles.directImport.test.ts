import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const directImportUploadMock = vi.hoisted(() => vi.fn());
const createWorkspaceFileTransferRpcCallerMock = vi.hoisted(() => vi.fn());

vi.mock('./uploadBulkPayloadFromFileWithCarrierFallbacks', () => ({
    uploadBulkPayloadFromFileWithCarrierFallbacks: (...args: unknown[]) => directImportUploadMock(...args),
}));

vi.mock('../families/workspaceFileTransferRpcCaller', () => ({
    createWorkspaceFileTransferRpcCaller: (...args: unknown[]) => createWorkspaceFileTransferRpcCallerMock(...args),
}));

describe('daemonWorkspaceFiles upload', () => {
    it('routes workspace uploads through the shared direct-to-relay carrier owner', async () => {
        directImportUploadMock.mockImplementation(async (params: any) => {
            expect(params.machineId).toBe('machine-1');
            expect(params.serverId).toBe('server-1');
            expect(params.fileReader.sizeBytes).toBe(5);
            await params.fileReader.readBytes(0, 5);
            expect(params.directImportRequest).toEqual({
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/payload.bin',
                sizeBytes: 5,
                overwrite: true,
            });
            return { success: true, path: '/repo/payload.bin', sizeBytes: 5, sha256: 'sha256:test' };
        });

        const { uploadDaemonWorkspaceFileFromReader } = await import('../families/workspaceFileTransfers');

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
        expect(directImportUploadMock).toHaveBeenCalledTimes(1);
        expect(createWorkspaceFileTransferRpcCallerMock).toHaveBeenCalledTimes(1);
    });
});
