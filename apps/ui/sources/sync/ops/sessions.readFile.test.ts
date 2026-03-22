import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRpcCallError } from '../runtime/rpcErrors';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

type SessionReadFileRpcResponse =
    | Readonly<{
        success: boolean;
        content?: string;
        downloadId?: string;
        chunkSizeBytes?: number;
        sizeBytes?: number;
        name?: string;
        contentBase64?: string;
        isLast?: boolean;
        error?: string;
    }>
    | null;
const sessionRPCSpy = vi.fn(
    async (_sessionId: string, _method: string, _payload: unknown): Promise<SessionReadFileRpcResponse> => ({
        success: true,
        content: 'aGVsbG8=',
    }),
);
const machineRPCSpy = vi.fn(
    async (_machineId: string, _method: string, _payload: unknown): Promise<SessionReadFileRpcResponse> => ({
        success: true,
        content: 'aGVsbG8=',
    }),
);
const sessionRpcWithServerScopeSpy = vi.fn();
const getStateSpy = vi.fn();
const downloadBulkPayloadToFileSpy = vi.fn();
const canUseSessionRpcSpy = vi.fn();
const readMachineTargetForSessionSpy = vi.fn();
const shouldFallbackToSessionRpcSpy = vi.fn(() => true);

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        sessionRPC: (sessionId: string, method: string, payload: any) => sessionRPCSpy(sessionId, method, payload),
        machineRPC: (machineId: string, method: string, payload: any) => machineRPCSpy(machineId, method, payload),
    },
}));

vi.mock('../domains/state/storage', () => ({
    storage: {
        getState: () => getStateSpy(),
    },
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    canUseSessionRpc: () => canUseSessionRpcSpy(),
    readMachineTargetForSession: () => readMachineTargetForSessionSpy(),
    resolveMachinePathFromSessionBase: ({ basePath, requestPath }: { basePath: string; requestPath: string }) => `${basePath}/${requestPath}`,
    shouldFallbackToSessionRpc: () => shouldFallbackToSessionRpcSpy(),
}));

vi.mock('@/sync/domains/transfers/runtime/bulkTransferPipeline', () => ({
    downloadBulkPayloadToFile: (params: unknown) => downloadBulkPayloadToFileSpy(params),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: (...args: unknown[]) => sessionRpcWithServerScopeSpy(...args),
}));

beforeEach(() => {
    sessionRPCSpy.mockClear();
    machineRPCSpy.mockClear();
    getStateSpy.mockReset();
    downloadBulkPayloadToFileSpy.mockReset();
    sessionRpcWithServerScopeSpy.mockReset();
    canUseSessionRpcSpy.mockReset();
    readMachineTargetForSessionSpy.mockReset();
    shouldFallbackToSessionRpcSpy.mockReset();
    shouldFallbackToSessionRpcSpy.mockReturnValue(true);
});

describe('sessionReadFile', () => {
    it('prefers machine RPC and resolves relative paths against the session cwd', async () => {
        const { sessionReadFile } = await import('./sessionFileSystem');

        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    metadata: {
                        path: '~/repo',
                        machineId: 'm1',
                    },
                },
            },
        });
        canUseSessionRpcSpy.mockReturnValue(true);
        readMachineTargetForSessionSpy.mockReturnValue({ machineId: 'm1', basePath: '/repo' });

        sessionRPCSpy.mockClear();
        machineRPCSpy.mockClear();
        downloadBulkPayloadToFileSpy.mockReset();

        const res = await sessionReadFile('s1', 'src/a.ts');
        expect(res.success).toBe(true);
        expect(downloadBulkPayloadToFileSpy).not.toHaveBeenCalled();
    });

    it('returns a stable failure response when the RPC returns an unsupported shape', async () => {
        const { sessionReadFile } = await import('./sessionFileSystem');

        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    metadata: {
                        path: '~/repo',
                        machineId: 'm1',
                    },
                },
            },
        });
        canUseSessionRpcSpy.mockReturnValue(true);
        readMachineTargetForSessionSpy.mockReturnValue({ machineId: 'm1', basePath: '/repo' });

        machineRPCSpy.mockRejectedValueOnce(
            createRpcCallError({ error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );
        downloadBulkPayloadToFileSpy.mockReset();
        sessionRpcWithServerScopeSpy.mockImplementation(async (_sessionId: string, method: string) => {
            if (method === 'daemon.sessionFiles.download.init') {
                return {
                    success: true,
                    downloadId: 'download-1',
                    chunkSizeBytes: 4,
                    sizeBytes: 5,
                    name: 'hello.txt',
                };
            }
            if (method === 'daemon.sessionFiles.download.chunk') {
                return { success: true, payloadBase64: Buffer.from('hello').toString('base64'), encryptedDataKeyEnvelopeBase64: 'envelope', isLast: true };
            }
            if (method === 'daemon.sessionFiles.download.finalize') {
                return { success: true };
            }
            if (method === 'daemon.sessionFiles.download.abort') {
                return { success: true };
            }
            throw new Error(`unexpected method ${method}`);
        });
        downloadBulkPayloadToFileSpy.mockImplementationOnce(async (params: {
            destination: { writeBytes: (bytes: Uint8Array) => Promise<void> };
            init: (request: { recipientPublicKeyBase64: string }) => Promise<{
                success: true;
                downloadId: string;
                chunkSizeBytes: number;
                sizeBytes: number;
                name: string;
            } | {
                success: false;
                error: string;
            }>;
            readChunk: (request: { downloadId: string; index: number }) => Promise<{ success: boolean; error?: string }>;
            finalize: (request: { downloadId: string }) => Promise<{ success: boolean; error?: string }>;
            abort: (request: { downloadId: string }) => Promise<{ success: boolean; error?: string }>;
        }) => {
            const init = await params.init({ recipientPublicKeyBase64: 'recipient-public-key' });
            expect(init).toMatchObject({
                success: true,
                downloadId: 'download-1',
                chunkSizeBytes: 4,
                sizeBytes: 5,
                name: 'hello.txt',
            });
            await params.readChunk({ downloadId: 'download-1', index: 0 });
            await params.finalize({ downloadId: 'download-1' });
            await params.destination.writeBytes(new TextEncoder().encode('hello'));
            return { ok: true, name: 'hello.txt', sizeBytes: 5 };
        });

        const res = await sessionReadFile('s1', 'src/a.ts');
        expect(res.success).toBe(false);
        if (res.success) {
            throw new Error('Expected sessionReadFile to fail');
        }
        expect(typeof res.error).toBe('string');
        expect(downloadBulkPayloadToFileSpy).toHaveBeenCalledTimes(1);
        expect(sessionRpcWithServerScopeSpy).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                sessionId: 's1',
                method: 'daemon.sessionFiles.download.init',
                payload: expect.objectContaining({
                    path: 'src/a.ts',
                }),
            }),
        );
        expect(sessionRpcWithServerScopeSpy).toHaveBeenCalledTimes(1);
    });

    it('falls back to the canonical bulk pipeline when direct machine readFile is unavailable', async () => {
        const { sessionReadFile } = await import('./sessionFileSystem');

        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: true,
                    metadata: {
                        path: '~/repo',
                        machineId: 'm1',
                    },
                },
            },
        });
        canUseSessionRpcSpy.mockReturnValue(true);
        readMachineTargetForSessionSpy.mockReturnValue({ machineId: 'm1', basePath: '/repo' });

        machineRPCSpy.mockRejectedValueOnce(
            createRpcCallError({ error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );
        downloadBulkPayloadToFileSpy.mockReset();
        downloadBulkPayloadToFileSpy.mockImplementationOnce(async (params: {
            destination: { writeBytes: (bytes: Uint8Array) => Promise<void> };
        }) => {
            await params.destination.writeBytes(new TextEncoder().encode('hello'));
            return { ok: true, name: 'hello.txt', sizeBytes: 5 };
        });
        sessionRPCSpy.mockImplementation(async (_sessionId: string, method: string) => {
            return { success: false, error: `unexpected method ${method}` };
        });

        const res = await sessionReadFile('s1', 'src/a.ts');
        expect(res).toEqual({ success: true, content: 'aGVsbG8=' });
        expect(downloadBulkPayloadToFileSpy).toHaveBeenCalledTimes(1);
        const [transferParams] = downloadBulkPayloadToFileSpy.mock.calls[0] ?? [];
        expect(transferParams).toEqual(expect.objectContaining({
            destination: expect.objectContaining({
                writeBytes: expect.any(Function),
                close: expect.any(Function),
                cleanup: expect.any(Function),
            }),
            init: expect.any(Function),
            readChunk: expect.any(Function),
            finalize: expect.any(Function),
            abort: expect.any(Function),
        }));
        expect(sessionRPCSpy).not.toHaveBeenCalledWith('s1', RPC_ERROR_CODES.METHOD_NOT_FOUND, expect.anything());
    });

    it('does not fall back to session RPC for inactive sessions', async () => {
        const { sessionReadFile } = await import('./sessionFileSystem');

        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        path: '~/repo',
                        machineId: 'm1',
                    },
                },
            },
        });
        canUseSessionRpcSpy.mockReturnValue(false);
        readMachineTargetForSessionSpy.mockReturnValue(null);

        machineRPCSpy.mockRejectedValueOnce(
            createRpcCallError({ error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );
        sessionRPCSpy.mockClear();
        sessionRPCSpy.mockResolvedValueOnce({
            success: true,
            content: 'aGVsbG8=',
        });

        const res = await sessionReadFile('s1', 'src/a.ts');
        expect(res.success).toBe(false);
        expect(sessionRPCSpy).not.toHaveBeenCalled();
        expect(downloadBulkPayloadToFileSpy).not.toHaveBeenCalled();
    });

    it('fails closed when inactive session has no machine target', async () => {
        const { sessionReadFile } = await import('./sessionFileSystem');

        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        path: '',
                        machineId: '',
                    },
                },
            },
            getProjectForSession: () => null,
        });
        canUseSessionRpcSpy.mockReturnValue(false);
        readMachineTargetForSessionSpy.mockReturnValue(null);

        sessionRPCSpy.mockClear();
        sessionRPCSpy.mockResolvedValueOnce({
            success: true,
            content: 'aGVsbG8=',
        });
        machineRPCSpy.mockClear();
        downloadBulkPayloadToFileSpy.mockReset();

        const res = await sessionReadFile('s1', 'src/a.ts');
        expect(res.success).toBe(false);
        expect(machineRPCSpy).not.toHaveBeenCalled();
        expect(sessionRPCSpy).not.toHaveBeenCalled();
        expect(downloadBulkPayloadToFileSpy).not.toHaveBeenCalled();
    });
});
