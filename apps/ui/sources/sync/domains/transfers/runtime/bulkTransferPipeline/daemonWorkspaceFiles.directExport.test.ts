import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const createWorkspaceFileTransferRpcCallerMock = vi.hoisted(() => vi.fn());
const downloadBulkPayloadToFileMock = vi.hoisted(() => vi.fn());
const callGuardedMachineRpcWithPolicyMock = vi.hoisted(() => vi.fn());
const relayFileDownloadMock = vi.hoisted(() => vi.fn());

vi.mock('./workspaceFileTransferRpcCaller', () => ({
    createWorkspaceFileTransferRpcCaller: (params: unknown) => createWorkspaceFileTransferRpcCallerMock(params),
}));

vi.mock('./downloadBulkPayloadToFile', () => ({
    downloadBulkPayloadToFile: (...args: unknown[]) => downloadBulkPayloadToFileMock(...args),
}));

vi.mock('./downloadBulkPayloadViaServerRelayToDestination', () => ({
    downloadBulkPayloadViaServerRelayToDestination: (...args: unknown[]) => relayFileDownloadMock(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: (...args: unknown[]) => callGuardedMachineRpcWithPolicyMock(...args),
}));

describe('daemonWorkspaceFiles direct export', () => {
    beforeEach(() => {
        vi.resetModules();
        createWorkspaceFileTransferRpcCallerMock.mockReset();
        downloadBulkPayloadToFileMock.mockReset();
        callGuardedMachineRpcWithPolicyMock.mockReset();
        relayFileDownloadMock.mockReset();
        callGuardedMachineRpcWithPolicyMock.mockResolvedValue({
            success: false,
            error: 'Direct export unavailable',
        });
    });

    it('tries direct export first, then relay-v2, before falling back to the bulk path for destination downloads', async () => {
        const rpcCall = vi.fn(async (params: any) => {
            if (params.machineMethod === RPC_METHODS.STAT_FILE) {
                return { success: true, exists: true, kind: 'file', sizeBytes: 5 };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'bulk-download-1',
                    chunkSizeBytes: 5,
                    sizeBytes: 5,
                    name: 'hello.txt',
                };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK) {
                return { success: true, isLast: true, contentBase64: '' };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            throw new Error(`unexpected method: ${params.machineMethod}`);
        });

        createWorkspaceFileTransferRpcCallerMock.mockImplementation(() => ({
            call: rpcCall,
        }));
        relayFileDownloadMock.mockResolvedValueOnce({
            ok: true as const,
            name: 'hello.txt',
            sizeBytes: 5,
        });

        const { downloadDaemonWorkspaceFileToDestination } = await import('./daemonWorkspaceFiles');
        const result = await downloadDaemonWorkspaceFileToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            rootPath: '/repo',
            request: { path: 'hello.txt', asZip: false },
            destination: {
                writeBytes: async () => {},
                close: async () => {},
                cleanup: async () => {},
            },
        });

        expect(result).toEqual({ ok: true, name: 'hello.txt', sizeBytes: 5 });
        expect(callGuardedMachineRpcWithPolicyMock).toHaveBeenCalledTimes(1);
        expect(relayFileDownloadMock).toHaveBeenCalledTimes(1);
        expect(relayFileDownloadMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            destination: expect.any(Object),
            onInit: null,
            init: expect.any(Function),
            finalize: expect.any(Function),
        }));
        expect(downloadBulkPayloadToFileMock).not.toHaveBeenCalled();
        expect(callGuardedMachineRpcWithPolicyMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
            payload: {
                t: 'workspace_file_download_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                asZip: false,
            },
        }));
    });

    it('tries direct export first, then relay-v2, before falling back to the bulk path for inline base64 reads', async () => {
        const rpcCall = vi.fn(async (params: any) => {
            if (params.machineMethod === RPC_METHODS.STAT_FILE) {
                return { success: true, exists: true, kind: 'file', sizeBytes: 3 };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'bulk-download-2',
                    chunkSizeBytes: 3,
                    sizeBytes: 3,
                    name: 'hello.txt',
                };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK) {
                return { success: true, isLast: true, contentBase64: '' };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            throw new Error(`unexpected method: ${params.machineMethod}`);
        });

        createWorkspaceFileTransferRpcCallerMock.mockImplementation(() => ({
            call: rpcCall,
        }));
        relayFileDownloadMock.mockImplementationOnce(async (params: any) => {
            await params.destination.writeBytes(new Uint8Array([1, 2, 3]));
            await params.destination.close();
            return { ok: true as const, name: 'hello.txt', sizeBytes: 3 };
        });

        const { downloadDaemonWorkspaceFileToBase64 } = await import('./daemonWorkspaceFiles');
        const result = await downloadDaemonWorkspaceFileToBase64({
            machineId: 'machine-1',
            serverId: 'server-a',
            rootPath: '/repo',
            path: 'hello.txt',
            maxBytes: 8,
        });

        expect(result).toEqual({ ok: true, contentBase64: 'AQID' });
        expect(callGuardedMachineRpcWithPolicyMock).toHaveBeenCalledTimes(1);
        expect(relayFileDownloadMock).toHaveBeenCalledTimes(1);
        expect(relayFileDownloadMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            destination: expect.any(Object),
            onInit: expect.any(Function),
            init: expect.any(Function),
            finalize: expect.any(Function),
        }));
        expect(downloadBulkPayloadToFileMock).not.toHaveBeenCalled();
        expect(callGuardedMachineRpcWithPolicyMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
            payload: {
                t: 'workspace_file_download_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                asZip: false,
            },
        }));
    });
});
