import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const createWorkspaceFileTransferRpcCallerMock = vi.hoisted(() => vi.fn());
const callGuardedMachineRpcWithPolicyMock = vi.hoisted(() => vi.fn());
const relayFileDownloadMock = vi.hoisted(() => vi.fn());

vi.mock('../families/workspaceFileTransferRpcCaller', () => ({
    createWorkspaceFileTransferRpcCaller: (params: unknown) => createWorkspaceFileTransferRpcCallerMock(params),
}));

vi.mock('./downloadBulkPayloadViaServerRelayToDestination', () => ({
    downloadBulkPayloadViaServerRelayToDestination: (...args: unknown[]) => relayFileDownloadMock(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: (...args: unknown[]) => callGuardedMachineRpcWithPolicyMock(...args),
}));

const { downloadDaemonWorkspaceFileToBase64, downloadDaemonWorkspaceFileToDestination } = await import('../families/workspaceFileTransfers');

describe('daemonWorkspaceFiles download size policy', () => {
    beforeEach(() => {
        createWorkspaceFileTransferRpcCallerMock.mockReset();
        callGuardedMachineRpcWithPolicyMock.mockReset();
        relayFileDownloadMock.mockReset();
        callGuardedMachineRpcWithPolicyMock.mockResolvedValue({
            success: false,
            error: 'Direct export unavailable',
        });
        relayFileDownloadMock.mockResolvedValue({
            ok: false,
            error: 'Relay download unavailable',
        });
    });

    it('preflights STAT_FILE before the bulk fallback when direct export and relay are unavailable', async () => {
        const rpcCall = vi.fn(async (params: any) => {
            if (params.machineMethod === RPC_METHODS.STAT_FILE) {
                expect(params.request).toEqual({ path: '/repo/a.txt' });
                return { success: true, exists: true, kind: 'file', sizeBytes: 3 };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'd1',
                    chunkSizeBytes: 8,
                    sizeBytes: 3,
                    name: 'a.txt',
                };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK) {
                return { success: true, isLast: true, contentBase64: 'AQID' };
            }
            throw new Error(`unexpected call: ${params.machineMethod}`);
        });

        createWorkspaceFileTransferRpcCallerMock.mockImplementation((params: any) => {
            expect(params).toEqual({ machineId: 'm1' });
            return { call: rpcCall };
        });

        const result = await downloadDaemonWorkspaceFileToDestination({
            machineId: 'm1',
            rootPath: '/repo',
            request: { path: 'a.txt', asZip: false },
            destination: {
                writeBytes: async () => undefined,
                close: async () => undefined,
                cleanup: async () => undefined,
            },
        });

        expect(result).toEqual({ ok: true, name: 'a.txt', sizeBytes: 3 });
        expect(createWorkspaceFileTransferRpcCallerMock).toHaveBeenCalledTimes(1);
        expect(createWorkspaceFileTransferRpcCallerMock).toHaveBeenCalledWith({ machineId: 'm1' });
        expect(rpcCall).toHaveBeenCalledWith(expect.objectContaining({
            machineMethod: RPC_METHODS.STAT_FILE,
            request: { path: '/repo/a.txt' },
        }));
        expect(rpcCall).toHaveBeenCalledWith(expect.objectContaining({
            machineMethod: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
            request: { downloadId: 'd1', index: 0 },
        }));
    });

    it('downloadDaemonWorkspaceFileToBase64 preflights STAT_FILE and uses the bulk fallback when direct export and relay are unavailable', async () => {
        const rpcCall = vi.fn(async (params: any) => {
            if (params.machineMethod === RPC_METHODS.STAT_FILE) {
                expect(params.request).toEqual({ path: '/repo/a.txt' });
                return { success: true, exists: true, kind: 'file', sizeBytes: 3 };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'd1',
                    chunkSizeBytes: 8,
                    sizeBytes: 3,
                    name: 'a.txt',
                };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK) {
                return { success: true, isLast: true, contentBase64: 'AQID' };
            }
            throw new Error(`unexpected call: ${params.machineMethod}`);
        });

        createWorkspaceFileTransferRpcCallerMock.mockImplementation((params: any) => {
            expect(params).toEqual({ machineId: 'm1' });
            return { call: rpcCall };
        });

        const result = await downloadDaemonWorkspaceFileToBase64({
            machineId: 'm1',
            rootPath: '/repo',
            path: 'a.txt',
            maxBytes: 128,
        });

        expect(result).toEqual({ ok: true, contentBase64: 'AQID' });
        expect(createWorkspaceFileTransferRpcCallerMock).toHaveBeenCalledTimes(1);
        expect(createWorkspaceFileTransferRpcCallerMock).toHaveBeenCalledWith({ machineId: 'm1' });
        expect(rpcCall).toHaveBeenCalledWith(expect.objectContaining({
            machineMethod: RPC_METHODS.STAT_FILE,
            request: { path: '/repo/a.txt' },
        }));
        expect(rpcCall).toHaveBeenCalledWith(expect.objectContaining({
            machineMethod: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
            request: { downloadId: 'd1', index: 0 },
        }));
    });

    it('keeps using the same transfer caller when zip init reports the archive size', async () => {
        const rpcCall = vi.fn(async (params: any) => {
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'zip-download-1',
                    chunkSizeBytes: 8,
                    sizeBytes: 50,
                    name: 'repo.zip',
                };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK) {
                return { success: true, isLast: true, contentBase64: Buffer.alloc(50, 1).toString('base64') };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            throw new Error(`unexpected rpc call: ${params.machineMethod}`);
        });

        createWorkspaceFileTransferRpcCallerMock.mockImplementation((params: any) => {
            expect(params).toEqual({ machineId: 'm1' });
            return { call: rpcCall };
        });

        const result = await downloadDaemonWorkspaceFileToDestination({
            machineId: 'm1',
            rootPath: '/repo',
            request: { path: 'repo', asZip: true },
            destination: {
                writeBytes: async () => undefined,
                close: async () => undefined,
                cleanup: async () => undefined,
            },
        });

        expect(result).toEqual({ ok: true, name: 'repo.zip', sizeBytes: 50 });
        expect(createWorkspaceFileTransferRpcCallerMock).toHaveBeenCalledTimes(1);
        expect(createWorkspaceFileTransferRpcCallerMock).toHaveBeenCalledWith({ machineId: 'm1' });
        expect(rpcCall).toHaveBeenCalledWith(expect.objectContaining({
            machineMethod: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
            request: { downloadId: 'zip-download-1', index: 0 },
        }));
    });

    it('downloadDaemonWorkspaceFileToBase64 fails closed when the file exceeds maxBytes (no bulk transfer init)', async () => {
        createWorkspaceFileTransferRpcCallerMock.mockImplementation((params: any) => {
            expect(params).toEqual({ machineId: 'm1' });
            return {
                call: vi.fn(async (callParams: any) => {
                    expect(callParams.machineMethod).toBe(RPC_METHODS.STAT_FILE);
                    expect(callParams.request).toEqual({ path: '/repo/a.txt' });
                    return { success: true, exists: true, kind: 'file', sizeBytes: 129 };
                }),
            };
        });

        const result = await downloadDaemonWorkspaceFileToBase64({
            machineId: 'm1',
            rootPath: '/repo',
            path: 'a.txt',
            maxBytes: 128,
        });

        expect(result.ok).toBe(false);
        expect(createWorkspaceFileTransferRpcCallerMock).toHaveBeenCalledTimes(1);
    });
});
