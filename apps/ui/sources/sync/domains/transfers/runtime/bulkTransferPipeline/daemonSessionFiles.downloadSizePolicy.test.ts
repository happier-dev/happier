import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const createSessionFileTransferRpcCallerMock = vi.hoisted(() => vi.fn());
const downloadBulkPayloadToFileMock = vi.hoisted(() => vi.fn());

vi.mock('./sessionFileTransferRpcCaller', () => ({
    createSessionFileTransferRpcCaller: (params: unknown) => createSessionFileTransferRpcCallerMock(params),
}));

vi.mock('./downloadBulkPayloadToFile', () => ({
    downloadBulkPayloadToFile: (...args: unknown[]) => downloadBulkPayloadToFileMock(...args),
}));

const { downloadDaemonSessionFileToBase64, downloadDaemonSessionFileToDestination } = await import('./daemonSessionFiles');

describe('daemonSessionFiles download size policy', () => {
    beforeEach(() => {
        createSessionFileTransferRpcCallerMock.mockReset();
        downloadBulkPayloadToFileMock.mockReset();
    });

    it('re-resolves zip download routes using init-reported size (uses sized transfer caller for chunks)', async () => {
        const initCall = vi.fn(async (params: any) => {
            if (params.sessionMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'd1',
                    chunkSizeBytes: 8,
                    sizeBytes: 50,
                    name: 'a.zip',
                };
            }
            if (params.sessionMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            throw new Error(`unexpected init call: ${params.sessionMethod}`);
        });

        const bulkCall = vi.fn(async (params: any) => {
            if (params.sessionMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK) {
                return { success: true, isLast: true, contentBase64: '' };
            }
            if (params.sessionMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            throw new Error(`unexpected bulk call: ${params.sessionMethod}`);
        });

        createSessionFileTransferRpcCallerMock.mockImplementation((params: any) => {
            if (params?.sessionRpcTransferSizeBytes !== undefined) {
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

        const result = await downloadDaemonSessionFileToDestination({
            sessionId: 's1',
            request: { path: 'a.zip', asZip: true },
            destination: {
                writeBytes: async () => undefined,
                close: async () => undefined,
            },
        });

        expect(result).toEqual({ ok: true, name: 'a.zip', sizeBytes: 50 });
        expect(createSessionFileTransferRpcCallerMock).toHaveBeenCalledTimes(2);
        expect(createSessionFileTransferRpcCallerMock).toHaveBeenNthCalledWith(1, { sessionId: 's1' });
        expect(createSessionFileTransferRpcCallerMock).toHaveBeenNthCalledWith(2, { sessionId: 's1', sessionRpcTransferSizeBytes: 50 });
        expect(initCall).toHaveBeenCalledTimes(1);
        expect(bulkCall).toHaveBeenCalledTimes(2);
    });

    it('preflights STAT_FILE and passes size into the bulk transfer route selection', async () => {
        const statCall = vi.fn(async (params: any) => {
            expect(params.sessionMethod).toBe(RPC_METHODS.STAT_FILE);
            expect(params.request).toEqual({ path: 'a.txt' });
            return { success: true, exists: true, kind: 'file', sizeBytes: 50 };
        });

        const downloadCall = vi.fn(async (params: any) => {
            if (params.sessionMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'd1',
                    chunkSizeBytes: 8,
                    sizeBytes: 50,
                    name: 'a.txt',
                };
            }
            if (params.sessionMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            if (params.sessionMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            if (params.sessionMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK) {
                return { success: true, isLast: true, contentBase64: '' };
            }
            throw new Error(`unexpected call: ${params.sessionMethod}`);
        });

        createSessionFileTransferRpcCallerMock.mockImplementation((params: any) => {
            if (params?.sessionRpcTransferSizeBytes !== undefined) {
                return { call: downloadCall };
            }
            return { call: statCall };
        });

        downloadBulkPayloadToFileMock.mockImplementation(async (params: any) => {
            const init = await params.init({ recipientPublicKeyBase64: 'pk' });
            expect(init.success).toBe(true);
            return { ok: true, name: init.name, sizeBytes: init.sizeBytes };
        });

        const result = await downloadDaemonSessionFileToDestination({
            sessionId: 's1',
            request: { path: 'a.txt', asZip: false },
            destination: {
                writeBytes: async () => undefined,
                close: async () => undefined,
            },
        });

        expect(result).toEqual({ ok: true, name: 'a.txt', sizeBytes: 50 });
        expect(createSessionFileTransferRpcCallerMock).toHaveBeenCalledTimes(2);
        expect(createSessionFileTransferRpcCallerMock).toHaveBeenNthCalledWith(1, { sessionId: 's1' });
        expect(createSessionFileTransferRpcCallerMock).toHaveBeenNthCalledWith(2, { sessionId: 's1', sessionRpcTransferSizeBytes: 50 });
        expect(statCall).toHaveBeenCalledTimes(1);
    });

    it('downloadDaemonSessionFileToBase64 preflights STAT_FILE and passes size into the bulk transfer route selection', async () => {
        const statCall = vi.fn(async (params: any) => {
            expect(params.sessionMethod).toBe(RPC_METHODS.STAT_FILE);
            expect(params.request).toEqual({ path: 'a.txt' });
            return { success: true, exists: true, kind: 'file', sizeBytes: 50 };
        });

        const downloadCall = vi.fn(async (params: any) => {
            if (params.sessionMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'd1',
                    chunkSizeBytes: 8,
                    sizeBytes: 50,
                    name: 'a.txt',
                };
            }
            if (params.sessionMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            if (params.sessionMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            if (params.sessionMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK) {
                return { success: true, isLast: true, contentBase64: '' };
            }
            throw new Error(`unexpected call: ${params.sessionMethod}`);
        });

        createSessionFileTransferRpcCallerMock.mockImplementation((params: any) => {
            if (params?.sessionRpcTransferSizeBytes !== undefined) {
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

        const result = await downloadDaemonSessionFileToBase64({
            sessionId: 's1',
            path: 'a.txt',
            maxBytes: 128,
        });

        expect(result).toEqual({ ok: true, contentBase64: 'AQID' });
        expect(createSessionFileTransferRpcCallerMock).toHaveBeenCalledTimes(2);
        expect(createSessionFileTransferRpcCallerMock).toHaveBeenNthCalledWith(1, { sessionId: 's1' });
        expect(createSessionFileTransferRpcCallerMock).toHaveBeenNthCalledWith(2, { sessionId: 's1', sessionRpcTransferSizeBytes: 50 });
        expect(statCall).toHaveBeenCalledTimes(1);
    });

    it('downloadDaemonSessionFileToBase64 fails closed when the file exceeds maxBytes (no bulk transfer init)', async () => {
        const statCall = vi.fn(async (params: any) => {
            expect(params.sessionMethod).toBe(RPC_METHODS.STAT_FILE);
            expect(params.request).toEqual({ path: 'a.txt' });
            return { success: true, exists: true, kind: 'file', sizeBytes: 129 };
        });

        const downloadCall = vi.fn(async () => {
            throw new Error('unexpected bulk transfer call');
        });

        createSessionFileTransferRpcCallerMock.mockImplementation((params: any) => {
            if (params?.sessionRpcTransferSizeBytes !== undefined) {
                return { call: downloadCall };
            }
            return { call: statCall };
        });

        const result = await downloadDaemonSessionFileToBase64({
            sessionId: 's1',
            path: 'a.txt',
            maxBytes: 128,
        });

        expect(result).toEqual({
            ok: false,
            error: 'File exceeds the inline file read size limit',
            errorCode: 'RPC_METHOD_NOT_AVAILABLE',
        });
        expect(createSessionFileTransferRpcCallerMock).toHaveBeenCalledTimes(1);
        expect(createSessionFileTransferRpcCallerMock).toHaveBeenNthCalledWith(1, { sessionId: 's1' });
        expect(statCall).toHaveBeenCalledTimes(1);
        expect(downloadBulkPayloadToFileMock).toHaveBeenCalledTimes(0);
    });
});
