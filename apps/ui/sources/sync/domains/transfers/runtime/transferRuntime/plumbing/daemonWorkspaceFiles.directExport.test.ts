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

describe('daemonWorkspaceFiles direct export', () => {
    beforeEach(() => {
        vi.resetModules();
        createWorkspaceFileTransferRpcCallerMock.mockReset();
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
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'bulk-download-1',
                    chunkSizeBytes: 5,
                    sizeBytes: 5,
                    name: 'hello.txt',
                };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK) {
                return { success: true, isLast: true, contentBase64: '' };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT) {
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

        const { downloadDaemonWorkspaceFileToDestination } = await import('../families/workspaceFileTransfers');
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

    it('cleans the destination and does not enter relay or bulk fallback after cancellation', async () => {
        const controller = new AbortController();
        const rpcCall = vi.fn(async (params: any) => {
            if (params.machineMethod === RPC_METHODS.STAT_FILE) {
                return { success: true, exists: true, kind: 'file', sizeBytes: 5 };
            }
            throw new Error(`unexpected method after cancellation: ${params.machineMethod}`);
        });
        createWorkspaceFileTransferRpcCallerMock.mockImplementation(() => ({ call: rpcCall }));
        callGuardedMachineRpcWithPolicyMock.mockImplementationOnce(async () => {
            controller.abort();
            return { success: false, error: 'Direct export unavailable' };
        });
        relayFileDownloadMock.mockResolvedValueOnce({
            ok: false as const,
            error: 'Relay must not start after cancellation',
        });
        const cleanup = vi.fn(async () => {});

        const { downloadDaemonWorkspaceFileToDestination } = await import('../families/workspaceFileTransfers');
        const result = await downloadDaemonWorkspaceFileToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            rootPath: '/repo',
            request: { path: 'hello.txt', asZip: false },
            destination: {
                writeBytes: async () => {},
                close: async () => {},
                cleanup,
            },
            signal: controller.signal,
        });

        expect(result).toEqual({ ok: false, error: 'Download canceled' });
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(relayFileDownloadMock).not.toHaveBeenCalled();
        expect(rpcCall).toHaveBeenCalledTimes(1);
    });

    it('tries direct export first, then relay-v2, before falling back to the bulk path for inline base64 reads', async () => {
        const rpcCall = vi.fn(async (params: any) => {
            if (params.machineMethod === RPC_METHODS.STAT_FILE) {
                return { success: true, exists: true, kind: 'file', sizeBytes: 3 };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'bulk-download-2',
                    chunkSizeBytes: 3,
                    sizeBytes: 3,
                    name: 'hello.txt',
                };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK) {
                return { success: true, isLast: true, contentBase64: '' };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT) {
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

        const { downloadDaemonWorkspaceFileToBase64 } = await import('../families/workspaceFileTransfers');
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

    it('falls back to the bulk path for destination downloads when relay-v2 is unavailable', async () => {
        const rpcCall = vi.fn(async (params: any) => {
            if (params.machineMethod === RPC_METHODS.STAT_FILE) {
                return { success: true, exists: true, kind: 'file', sizeBytes: 5 };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'bulk-download-fallback',
                    chunkSizeBytes: 5,
                    sizeBytes: 5,
                    name: 'hello.txt',
                };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK) {
                return {
                    success: true,
                    isLast: true,
                    contentBase64: 'aGVsbG8=',
                };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            throw new Error(`unexpected method: ${params.machineMethod}`);
        });

        createWorkspaceFileTransferRpcCallerMock.mockImplementation(() => ({
            call: rpcCall,
        }));
        relayFileDownloadMock.mockResolvedValueOnce({
            ok: false as const,
            error: 'Relay unavailable',
        });

        const written: Uint8Array[] = [];
        const close = vi.fn(async () => {});
        const cleanup = vi.fn(async () => {});
        const { downloadDaemonWorkspaceFileToDestination } = await import('../families/workspaceFileTransfers');
        const result = await downloadDaemonWorkspaceFileToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            rootPath: '/repo',
            request: { path: 'hello.txt', asZip: false },
            destination: {
                writeBytes: async (bytes) => {
                    written.push(bytes);
                },
                close,
                cleanup,
            },
        });

        expect(result).toEqual({ ok: true, name: 'hello.txt', sizeBytes: 5 });
        expect(new TextDecoder().decode(Uint8Array.from(written.flatMap((chunk) => Array.from(chunk))))).toBe('hello');
        expect(relayFileDownloadMock).toHaveBeenCalledTimes(1);
        expect(rpcCall).toHaveBeenCalledWith(expect.objectContaining({
            machineMethod: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
            request: { downloadId: 'bulk-download-fallback', index: 0 },
        }));
        expect(close).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledTimes(2);
    });

    it('resets the destination between direct, relay, and bulk carrier attempts', async () => {
        const calls: string[] = [];
        const rpcCall = vi.fn(async (params: any) => {
            if (params.machineMethod === RPC_METHODS.STAT_FILE) {
                return { success: true, exists: true, kind: 'file', sizeBytes: 5 };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT) {
                calls.push('bulkInit');
                return {
                    success: true,
                    downloadId: 'bulk-download-reset',
                    chunkSizeBytes: 5,
                    sizeBytes: 5,
                    name: 'hello.txt',
                };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK) {
                return { success: true, isLast: true, contentBase64: 'aGVsbG8=' };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            throw new Error(`unexpected method: ${params.machineMethod}`);
        });
        createWorkspaceFileTransferRpcCallerMock.mockImplementation(() => ({ call: rpcCall }));
        relayFileDownloadMock.mockImplementationOnce(async () => {
            calls.push('relay');
            return { ok: false as const, error: 'Relay unavailable' };
        });
        const cleanup = vi.fn(async () => {
            calls.push('cleanup');
        });

        const { downloadDaemonWorkspaceFileToDestination } = await import('../families/workspaceFileTransfers');
        const result = await downloadDaemonWorkspaceFileToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            rootPath: '/repo',
            request: { path: 'hello.txt', asZip: false },
            destination: {
                writeBytes: async () => {},
                close: async () => {},
                cleanup,
            },
        });

        expect(result).toEqual({ ok: true, name: 'hello.txt', sizeBytes: 5 });
        expect(calls).toEqual(['cleanup', 'relay', 'cleanup', 'bulkInit']);
        expect(cleanup).toHaveBeenCalledTimes(2);
    });

    it('fails closed before starting carrier fallback when the destination does not provide cleanup', async () => {
        const rpcCall = vi.fn(async (params: any) => {
            if (params.machineMethod === RPC_METHODS.STAT_FILE) {
                return { success: true, exists: true, kind: 'file', sizeBytes: 5 };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'bulk-download-retryable-destination',
                    chunkSizeBytes: 5,
                    sizeBytes: 5,
                    name: 'hello.txt',
                };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK) {
                return {
                    success: true,
                    isLast: true,
                    contentBase64: 'aGVsbG8=',
                };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            throw new Error(`unexpected method: ${params.machineMethod}`);
        });

        createWorkspaceFileTransferRpcCallerMock.mockImplementation(() => ({
            call: rpcCall,
        }));
        const written: Uint8Array[] = [];
        let closed = false;
        const close = vi.fn(async () => {
            closed = true;
        });
        const { downloadDaemonWorkspaceFileToDestination } = await import('../families/workspaceFileTransfers');
        const result = await downloadDaemonWorkspaceFileToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            rootPath: '/repo',
            request: { path: 'hello.txt', asZip: false },
            destination: {
                writeBytes: async (bytes) => {
                    if (closed) {
                        throw new Error('destination already closed');
                    }
                    written.push(bytes);
                },
                close,
            },
        });

        expect(result).toEqual({
            ok: false,
            error: 'Workspace file download destination cleanup is required for retry-safe transfers',
        });
        expect(written).toEqual([]);
        expect(close).not.toHaveBeenCalled();
        expect(createWorkspaceFileTransferRpcCallerMock).not.toHaveBeenCalled();
        expect(relayFileDownloadMock).not.toHaveBeenCalled();
    });

    it('falls back to the bulk path for inline base64 reads when relay-v2 is unavailable', async () => {
        const rpcCall = vi.fn(async (params: any) => {
            if (params.machineMethod === RPC_METHODS.STAT_FILE) {
                return { success: true, exists: true, kind: 'file', sizeBytes: 3 };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'bulk-download-inline-fallback',
                    chunkSizeBytes: 3,
                    sizeBytes: 3,
                    name: 'hello.txt',
                };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK) {
                return {
                    success: true,
                    isLast: true,
                    contentBase64: 'AQID',
                };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            throw new Error(`unexpected method: ${params.machineMethod}`);
        });

        createWorkspaceFileTransferRpcCallerMock.mockImplementation(() => ({
            call: rpcCall,
        }));
        relayFileDownloadMock.mockResolvedValueOnce({
            ok: false as const,
            error: 'Relay unavailable',
        });

        const { downloadDaemonWorkspaceFileToBase64 } = await import('../families/workspaceFileTransfers');
        const result = await downloadDaemonWorkspaceFileToBase64({
            machineId: 'machine-1',
            serverId: 'server-a',
            rootPath: '/repo',
            path: 'hello.txt',
            maxBytes: 8,
        });

        expect(result).toEqual({ ok: true, contentBase64: 'AQID' });
        expect(relayFileDownloadMock).toHaveBeenCalledTimes(1);
        expect(rpcCall).toHaveBeenCalledWith(expect.objectContaining({
            machineMethod: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
            request: { downloadId: 'bulk-download-inline-fallback', index: 0 },
        }));
    });

    it('finalizes zip relay downloads without rebuilding the transfer caller from init metadata', async () => {
        const rpcCall = vi.fn(async (params: any) => {
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'relay-download-zip',
                    chunkSizeBytes: 8,
                    sizeBytes: 77,
                    name: 'repo.zip',
                };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            if (params.machineMethod === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            throw new Error(`unexpected rpc call: ${params.machineMethod}`);
        });

        createWorkspaceFileTransferRpcCallerMock.mockImplementation((params: any) => {
            expect(params).toEqual({
                machineId: 'machine-1',
                serverId: 'server-a',
            });
            return { call: rpcCall };
        });

        relayFileDownloadMock.mockImplementationOnce(async (params: any) => {
            const init = await params.init({ recipientPublicKeyBase64: 'pk' });
            expect(init).toMatchObject({
                success: true,
                downloadId: 'relay-download-zip',
                sizeBytes: 77,
                name: 'repo.zip',
            });
            await params.finalize({ downloadId: 'relay-download-zip' });
            return { ok: true as const, name: init.name, sizeBytes: init.sizeBytes };
        });

        const { downloadDaemonWorkspaceFileToDestination } = await import('../families/workspaceFileTransfers');
        const result = await downloadDaemonWorkspaceFileToDestination({
            machineId: 'machine-1',
            serverId: 'server-a',
            rootPath: '/repo',
            request: { path: 'repo', asZip: true },
            destination: {
                writeBytes: async () => {},
                close: async () => {},
                cleanup: async () => {},
            },
        });

        expect(result).toEqual({ ok: true, name: 'repo.zip', sizeBytes: 77 });
        expect(createWorkspaceFileTransferRpcCallerMock).toHaveBeenCalledTimes(1);
        expect(createWorkspaceFileTransferRpcCallerMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-a',
        });
        expect(rpcCall).toHaveBeenCalledWith(expect.objectContaining({
            machineMethod: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
        }));
        expect(rpcCall).toHaveBeenCalledWith(expect.objectContaining({
            machineMethod: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE,
        }));
    });
});
