import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const createSessionFileTransferRpcCallerMock = vi.hoisted(() => vi.fn());

vi.mock('./sessionFileTransferRpcCaller', () => ({
    createSessionFileTransferRpcCaller: (params: unknown) => createSessionFileTransferRpcCallerMock(params),
}));

import { downloadDaemonSessionFileToBase64, downloadDaemonSessionFileToDestination } from './daemonSessionFiles';

function base64(bytes: readonly number[]): string {
    return Buffer.from(Uint8Array.from(bytes)).toString('base64');
}

describe('daemonSessionFiles download', () => {
    beforeEach(() => {
        createSessionFileTransferRpcCallerMock.mockReset();
    });

    it('re-evaluates chunk-route policy using the init sizeBytes (zip/unknown size)', async () => {
        const initCallerCall = vi.fn();
        const chunkCallerCall = vi.fn();

        createSessionFileTransferRpcCallerMock.mockImplementation((params: any) => {
            if (params?.sessionRpcTransferSizeBytes == null) {
                return { call: initCallerCall };
            }
            return { call: chunkCallerCall };
        });

        initCallerCall.mockImplementation(async ({ machineMethod }: any) => {
            if (machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'download-1',
                    chunkSizeBytes: 10,
                    sizeBytes: 4,
                    name: 'archive.zip',
                };
            }
            if (machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            throw new Error(`unexpected init caller method: ${String(machineMethod)}`);
        });

        chunkCallerCall.mockImplementation(async ({ machineMethod }: any) => {
            if (machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK) {
                return { success: true, contentBase64: base64([1, 2, 3, 4]), isLast: true };
            }
            if (machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            if (machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            throw new Error(`unexpected chunk caller method: ${String(machineMethod)}`);
        });

        const chunks: Uint8Array[] = [];
        const res = await downloadDaemonSessionFileToDestination({
            sessionId: 'session-1',
            request: { path: 'repo', asZip: true },
            destination: {
                writeBytes: async (bytes) => {
                    chunks.push(bytes);
                },
                close: async () => {},
                cleanup: async () => {},
            },
        });

        expect(res).toEqual({ ok: true, name: 'archive.zip', sizeBytes: 4 });
        expect(chunks).toHaveLength(1);
        expect(Buffer.from(chunks[0]!).toString('hex')).toBe(Buffer.from([1, 2, 3, 4]).toString('hex'));

        expect(createSessionFileTransferRpcCallerMock).toHaveBeenCalledTimes(2);
        expect(createSessionFileTransferRpcCallerMock.mock.calls[0]?.[0]).toEqual({
            sessionId: 'session-1',
        });
        expect(createSessionFileTransferRpcCallerMock.mock.calls[1]?.[0]).toEqual({
            sessionId: 'session-1',
            sessionRpcTransferSizeBytes: 4,
        });
    });

    it('uses the size-agnostic caller for abort when the chunk route is denied due to size', async () => {
        const initCallerCall = vi.fn();
        const chunkCallerCall = vi.fn();

        createSessionFileTransferRpcCallerMock.mockImplementation((params: any) => {
            if (params?.sessionRpcTransferSizeBytes == null) {
                return { call: initCallerCall };
            }
            return { call: chunkCallerCall };
        });

        initCallerCall.mockImplementation(async ({ machineMethod }: any) => {
            if (machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'download-2',
                    chunkSizeBytes: 10,
                    sizeBytes: 400,
                    name: 'too-large.zip',
                };
            }
            if (machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            throw new Error(`unexpected init caller method: ${String(machineMethod)}`);
        });

        chunkCallerCall.mockImplementation(async ({ machineMethod }: any) => {
            if (machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK) {
                return { success: false, error: 'Too large', errorCode: 'server_routed_file_transfer_too_large' };
            }
            if (machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            throw new Error(`unexpected chunk caller method: ${String(machineMethod)}`);
        });

        const res = await downloadDaemonSessionFileToDestination({
            sessionId: 'session-1',
            request: { path: 'repo', asZip: true },
            destination: {
                writeBytes: async () => {},
                close: async () => {},
                cleanup: async () => {},
            },
        });

        expect(res.ok).toBe(false);
        expect(initCallerCall).toHaveBeenCalledWith(
            expect.objectContaining({
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT,
                sessionMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT,
                request: { downloadId: 'download-2' },
            }),
        );
    });

    it('re-evaluates chunk-route policy using init sizeBytes for base64 reads', async () => {
        const initCallerCall = vi.fn();
        const chunkCallerCall = vi.fn();

        createSessionFileTransferRpcCallerMock.mockImplementation((params: any) => {
            if (params?.sessionRpcTransferSizeBytes == null) {
                return { call: initCallerCall };
            }
            return { call: chunkCallerCall };
        });

        initCallerCall.mockImplementation(async ({ machineMethod }: any) => {
            if (machineMethod === RPC_METHODS.STAT_FILE) {
                return {
                    success: true,
                    exists: true,
                    kind: 'file',
                    sizeBytes: 4,
                };
            }
            if (machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'download-b64-1',
                    chunkSizeBytes: 10,
                    sizeBytes: 4,
                    name: 'file.txt',
                };
            }
            if (machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            throw new Error(`unexpected init caller method: ${String(machineMethod)}`);
        });

        chunkCallerCall.mockImplementation(async ({ machineMethod }: any) => {
            if (machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'download-b64-1',
                    chunkSizeBytes: 10,
                    sizeBytes: 4,
                    name: 'file.txt',
                };
            }
            if (machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK) {
                return { success: true, contentBase64: base64([1, 2, 3, 4]), isLast: true };
            }
            if (machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            if (machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            throw new Error(`unexpected chunk caller method: ${String(machineMethod)}`);
        });

        const res = await downloadDaemonSessionFileToBase64({
            sessionId: 'session-1',
            path: 'repo/file.txt',
            maxBytes: 100,
        });

        expect(res).toEqual({ ok: true, contentBase64: base64([1, 2, 3, 4]) });

        expect(createSessionFileTransferRpcCallerMock).toHaveBeenCalledTimes(2);
        expect(createSessionFileTransferRpcCallerMock.mock.calls[0]?.[0]).toEqual({
            sessionId: 'session-1',
        });
        expect(createSessionFileTransferRpcCallerMock.mock.calls[1]?.[0]).toEqual({
            sessionId: 'session-1',
            sessionRpcTransferSizeBytes: 4,
        });
    });
});
