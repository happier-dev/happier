import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const createWorkspaceFileTransferRpcCallerMock = vi.hoisted(() => vi.fn());
const downloadBulkPayloadToFileMock = vi.hoisted(() => vi.fn());

vi.mock('./workspaceFileTransferRpcCaller', () => ({
    createWorkspaceFileTransferRpcCaller: (params: unknown) => createWorkspaceFileTransferRpcCallerMock(params),
}));

vi.mock('./downloadBulkPayloadToFile', () => ({
    downloadBulkPayloadToFile: (...args: unknown[]) => downloadBulkPayloadToFileMock(...args),
}));

const { downloadDaemonWorkspaceFileToBase64, downloadDaemonWorkspaceFileToDestination } = await import('./daemonWorkspaceFiles');

describe('daemonWorkspaceFiles download size policy', () => {
    beforeEach(() => {
        createWorkspaceFileTransferRpcCallerMock.mockReset();
        downloadBulkPayloadToFileMock.mockReset();
    });

    it('re-resolves zip download routes using init-reported size (uses sized transfer caller for chunks)', async () => {
        const initCall = vi.fn(async (params: any) => {
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'd1',
                    chunkSizeBytes: 8,
                    sizeBytes: 50,
                    name: 'a.zip',
                };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            throw new Error(`unexpected init call: ${params.machineMethod}`);
        });

        const bulkCall = vi.fn(async (params: any) => {
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK) {
                return { success: true, isLast: true, contentBase64: '' };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            throw new Error(`unexpected bulk call: ${params.machineMethod}`);
        });

        createWorkspaceFileTransferRpcCallerMock.mockImplementation((params: any) => {
            if (params?.transferSizeBytes !== undefined) {
                return { call: bulkCall };
            }
            return { call: initCall };
        });

        downloadBulkPayloadToFileMock.mockImplementation(async (params: any) => {
            const init = await params.init({ recipientPublicKeyBase64: 'pk', asZip: true });
            expect(init.success).toBe(true);
            await params.readChunk({ downloadId: 'd1', index: 0 });
            await params.finalize({ downloadId: 'd1' });
            return { ok: true, name: init.name, sizeBytes: init.sizeBytes };
        });

        const result = await downloadDaemonWorkspaceFileToDestination({
            machineId: 'm1',
            rootPath: '/repo',
            request: { path: 'a.zip', asZip: true },
            destination: {
                writeBytes: async () => undefined,
                close: async () => undefined,
            },
        });

        expect(result).toEqual({ ok: true, name: 'a.zip', sizeBytes: 50 });
        expect(createWorkspaceFileTransferRpcCallerMock).toHaveBeenCalledTimes(2);
        expect(createWorkspaceFileTransferRpcCallerMock).toHaveBeenNthCalledWith(1, { machineId: 'm1' });
        expect(createWorkspaceFileTransferRpcCallerMock).toHaveBeenNthCalledWith(2, { machineId: 'm1', transferSizeBytes: 50 });
        expect(initCall).toHaveBeenCalledTimes(1);
        expect(bulkCall).toHaveBeenCalledTimes(2);
    });

    it('preflights STAT_FILE and passes size into the bulk transfer route selection', async () => {
        const statCall = vi.fn(async (params: any) => {
            expect(params.machineMethod).toBe(RPC_METHODS.STAT_FILE);
            expect(params.request).toEqual({ path: '/repo/a.txt' });
            return { success: true, exists: true, kind: 'file', sizeBytes: 50 };
        });

        const downloadCall = vi.fn(async (params: any) => {
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'd1',
                    chunkSizeBytes: 8,
                    sizeBytes: 50,
                    name: 'a.txt',
                };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK) {
                return { success: true, isLast: true, contentBase64: '' };
            }
            throw new Error(`unexpected call: ${params.machineMethod}`);
        });

        createWorkspaceFileTransferRpcCallerMock.mockImplementation((params: any) => {
            if (params?.transferSizeBytes !== undefined) {
                return { call: downloadCall };
            }
            return { call: statCall };
        });

        downloadBulkPayloadToFileMock.mockImplementation(async (params: any) => {
            const init = await params.init({ recipientPublicKeyBase64: 'pk' });
            expect(init.success).toBe(true);
            return { ok: true, name: init.name, sizeBytes: init.sizeBytes };
        });

        const result = await downloadDaemonWorkspaceFileToDestination({
            machineId: 'm1',
            rootPath: '/repo',
            request: { path: 'a.txt', asZip: false },
            destination: {
                writeBytes: async () => undefined,
                close: async () => undefined,
            },
        });

        expect(result).toEqual({ ok: true, name: 'a.txt', sizeBytes: 50 });
        expect(createWorkspaceFileTransferRpcCallerMock).toHaveBeenCalledTimes(2);
        expect(createWorkspaceFileTransferRpcCallerMock).toHaveBeenNthCalledWith(1, { machineId: 'm1' });
        expect(createWorkspaceFileTransferRpcCallerMock).toHaveBeenNthCalledWith(2, { machineId: 'm1', transferSizeBytes: 50 });
        expect(statCall).toHaveBeenCalledTimes(1);
    });

    it('downloadDaemonWorkspaceFileToBase64 preflights STAT_FILE and passes size into the bulk transfer route selection', async () => {
        const statCall = vi.fn(async (params: any) => {
            expect(params.machineMethod).toBe(RPC_METHODS.STAT_FILE);
            expect(params.request).toEqual({ path: '/repo/a.txt' });
            return { success: true, exists: true, kind: 'file', sizeBytes: 50 };
        });

        const downloadCall = vi.fn(async (params: any) => {
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'd1',
                    chunkSizeBytes: 8,
                    sizeBytes: 50,
                    name: 'a.txt',
                };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK) {
                return { success: true, isLast: true, contentBase64: '' };
            }
            throw new Error(`unexpected call: ${params.machineMethod}`);
        });

        createWorkspaceFileTransferRpcCallerMock.mockImplementation((params: any) => {
            if (params?.transferSizeBytes !== undefined) {
                return { call: downloadCall };
            }
            return { call: statCall };
        });

        downloadBulkPayloadToFileMock.mockImplementation(async (params: any) => {
            const init = await params.init({ recipientPublicKeyBase64: 'pk' });
            expect(init.success).toBe(true);
            await params.destination.writeBytes(new Uint8Array([1, 2, 3]));
            return { ok: true, name: init.name, sizeBytes: init.sizeBytes };
        });

        const result = await downloadDaemonWorkspaceFileToBase64({
            machineId: 'm1',
            rootPath: '/repo',
            path: 'a.txt',
            maxBytes: 128,
        });

        expect(result).toEqual({ ok: true, contentBase64: 'AQID' });
        expect(createWorkspaceFileTransferRpcCallerMock).toHaveBeenCalledTimes(2);
        expect(createWorkspaceFileTransferRpcCallerMock).toHaveBeenNthCalledWith(1, { machineId: 'm1' });
        expect(createWorkspaceFileTransferRpcCallerMock).toHaveBeenNthCalledWith(2, { machineId: 'm1', transferSizeBytes: 50 });
        expect(statCall).toHaveBeenCalledTimes(1);
    });

    it('downloadDaemonWorkspaceFileToBase64 fails closed when the file exceeds maxBytes (no bulk transfer init)', async () => {
        const statCall = vi.fn(async (params: any) => {
            expect(params.machineMethod).toBe(RPC_METHODS.STAT_FILE);
            expect(params.request).toEqual({ path: '/repo/a.txt' });
            return { success: true, exists: true, kind: 'file', sizeBytes: 129 };
        });

        const downloadCall = vi.fn(async () => {
            throw new Error('unexpected bulk transfer call');
        });

        createWorkspaceFileTransferRpcCallerMock.mockImplementation((params: any) => {
            if (params?.transferSizeBytes !== undefined) {
                return { call: downloadCall };
            }
            return { call: statCall };
        });

        const result = await downloadDaemonWorkspaceFileToBase64({
            machineId: 'm1',
            rootPath: '/repo',
            path: 'a.txt',
            maxBytes: 128,
        });

        expect(result.ok).toBe(false);
        expect(downloadCall).toHaveBeenCalledTimes(0);
    });
});
