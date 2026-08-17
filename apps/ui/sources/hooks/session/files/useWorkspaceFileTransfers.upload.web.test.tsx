import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, renderScreen } from '@/dev/testkit';
import { installSessionFilesHookCommonModuleMocks } from './sessionFilesHookTestHelpers';

const uploadDaemonWorkspaceFileFromReaderMock = vi.hoisted(() => vi.fn());
const callDaemonWorkspaceStatFileRpcMock = vi.hoisted(() => vi.fn());
const openLocalUploadSourceReaderMock = vi.hoisted(() => vi.fn());
const uploadReaderCloseSpy = vi.hoisted(() => vi.fn());
const runTransferFinalizeRecoveryMock = vi.hoisted(() => vi.fn());

installSessionFilesHookCommonModuleMocks();

vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    uploadDaemonWorkspaceFileFromReader: (...args: unknown[]) => uploadDaemonWorkspaceFileFromReaderMock(...args),
    callDaemonWorkspaceStatFileRpc: (...args: unknown[]) => callDaemonWorkspaceStatFileRpcMock(...args),
}));

vi.mock('@/sync/runtime/files/localUploadSourceReader', () => ({
    openLocalUploadSourceReader: (...args: unknown[]) => openLocalUploadSourceReaderMock(...args),
    resolveLocalUploadSourceSizeBytes: async (source: { kind: 'web'; file: File }) => source.file.size,
}));

vi.mock('@/components/transfers/recovery/runTransferFinalizeRecovery', () => ({
    runTransferFinalizeRecovery: (...args: unknown[]) => runTransferFinalizeRecoveryMock(...args),
}));

describe('useWorkspaceFileTransfers upload pipeline', () => {
    type WorkspaceFileTransfersApi = Readonly<{
        uploadState:
            | Readonly<{ status: 'idle' }>
            | Readonly<{ status: 'preflighting' | 'uploading'; totalFiles: number; completedFiles: number; uploadedBytes: number; totalBytes: number }>
            | Readonly<{ status: 'done'; totalFiles: number; totalBytes: number }>
            | Readonly<{ status: 'canceled' }>
            | Readonly<{ status: 'error'; error: string }>;
        startUploads: (input: Readonly<{
            entries: readonly Readonly<{ kind: 'web'; file: File; relativePath: string }>[];
            destinationDir: string;
        }>) => Promise<{ ok: boolean; error?: string }>;
    }>;

    beforeEach(() => {
        uploadDaemonWorkspaceFileFromReaderMock.mockReset();
        callDaemonWorkspaceStatFileRpcMock.mockReset();
        openLocalUploadSourceReaderMock.mockReset();
        uploadReaderCloseSpy.mockReset();
        runTransferFinalizeRecoveryMock.mockReset();
        openLocalUploadSourceReaderMock.mockImplementation(async (source: { kind: 'web'; file: File }) => ({
            sizeBytes: source.file.size,
            readBytes: async (offset: number, length: number) => {
                const nextEnd = Math.min(source.file.size, offset + length);
                const chunkBlob = source.file.slice(offset, nextEnd);
                return new Uint8Array(await chunkBlob.arrayBuffer());
            },
            close: uploadReaderCloseSpy,
        }));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('uploads files through the canonical bulk pipeline helper', async () => {
        callDaemonWorkspaceStatFileRpcMock.mockResolvedValue({ success: true, exists: false });

        uploadDaemonWorkspaceFileFromReaderMock.mockImplementation(async (params: {
            machineId: string;
            serverId?: string | null;
            rootPath: string;
            fileReader: {
                sizeBytes: number;
                readBytes: (offset: number, length: number) => Promise<Uint8Array>;
                close: () => Promise<void>;
            };
            request: {
                path: string;
                sizeBytes: number;
                overwrite?: boolean;
                sha256?: string;
            };
            onProgress?: ((progress: { uploadedBytes: number; totalBytes: number }) => void) | null;
            signal?: AbortSignal | null;
        }) => {
            expect(params.machineId).toBe('m1');
            expect(params.serverId).toBe('server-1');
            expect(params.rootPath).toBe('/repo');
            expect(params.fileReader.sizeBytes).toBe(5);
            expect(params.request).toEqual({
                path: 'workspace/files/hello.txt',
                sizeBytes: 5,
                overwrite: false,
            });
            await params.fileReader.readBytes(0, 5);
            params.onProgress?.({ uploadedBytes: 5, totalBytes: 5 });
            await params.fileReader.close();
            return {
                success: true,
                path: 'workspace/files/hello.txt',
                sizeBytes: 5,
                sha256: 'sha256',
            };
        });

        const { useWorkspaceFileTransfers } = await import('@/hooks/workspaces/transfers/useWorkspaceFileTransfers');

        let api: WorkspaceFileTransfersApi | null = null;
        function Test() {
            api = useWorkspaceFileTransfers({
                workspaceScope: {
                    serverId: 'server-1',
                    machineId: 'm1',
                    rootPath: '/repo',
                },
            }) as unknown as WorkspaceFileTransfersApi;
            return null;
        }

        await renderScreen(<Test />);

        if (!api) throw new Error('expected hook api');

        const file = new File([new TextEncoder().encode('hello')], 'hello.txt', { type: 'text/plain' });

        await act(async () => {
            await (api as WorkspaceFileTransfersApi).startUploads({
                destinationDir: 'workspace/files',
                entries: [
                    {
                        kind: 'web',
                        file,
                        relativePath: 'hello.txt',
                    },
                ],
            });
        });

        expect(uploadDaemonWorkspaceFileFromReaderMock).toHaveBeenCalledTimes(1);
        expect(uploadReaderCloseSpy).toHaveBeenCalledTimes(1);
    });

    it('keeps the idle transfer API stable when the same workspace scope is passed again', async () => {
        const { useWorkspaceFileTransfers } = await import('@/hooks/workspaces/transfers/useWorkspaceFileTransfers');

        const hook = await renderHook(
            (props: Parameters<typeof useWorkspaceFileTransfers>[0]) => useWorkspaceFileTransfers(props),
            {
                initialProps: {
                    workspaceScope: {
                        serverId: 'server-1',
                        machineId: 'm1',
                        rootPath: '/repo',
                    },
                },
            },
        );

        const initialApi = hook.getCurrent();

        await hook.rerender({
            workspaceScope: {
                serverId: 'server-1',
                machineId: 'm1',
                rootPath: '/repo',
            },
        });

        expect(hook.getCurrent()).toBe(initialApi);
    });

    it('surfaces upload helper failures as errors instead of canceled states', async () => {
        callDaemonWorkspaceStatFileRpcMock.mockResolvedValue({ success: true, exists: false });

        uploadDaemonWorkspaceFileFromReaderMock.mockResolvedValue({
            success: false,
            error: 'Upload finalize failed',
        });

        const { useWorkspaceFileTransfers } = await import('@/hooks/workspaces/transfers/useWorkspaceFileTransfers');

        let api: WorkspaceFileTransfersApi | null = null;
        function Test() {
            api = useWorkspaceFileTransfers({
                workspaceScope: {
                    serverId: 'server-1',
                    machineId: 'm1',
                    rootPath: '/repo',
                },
            }) as unknown as WorkspaceFileTransfersApi;
            return null;
        }

        await renderScreen(<Test />);

        if (!api) throw new Error('expected hook api');
        const currentApi = api as WorkspaceFileTransfersApi;

        const file = new File([new TextEncoder().encode('hello')], 'hello.txt', { type: 'text/plain' });

        let result: { ok: boolean; error?: string } | null = null;
        await act(async () => {
            result = await api!.startUploads({
                destinationDir: 'workspace/files',
                entries: [
                    {
                        kind: 'web',
                        file,
                        relativePath: 'hello.txt',
                    },
                ],
            });
        });

        expect(result).toEqual({ ok: false, error: 'Upload finalize failed' });
        expect(uploadDaemonWorkspaceFileFromReaderMock).toHaveBeenCalledTimes(1);
    });

    it('surfaces thrown upload helper failures as errors instead of rejecting the batch', async () => {
        callDaemonWorkspaceStatFileRpcMock.mockResolvedValue({ success: true, exists: false });

        uploadDaemonWorkspaceFileFromReaderMock.mockImplementation(async () => {
            throw new Error('Upload source reader exploded');
        });

        const { useWorkspaceFileTransfers } = await import('@/hooks/workspaces/transfers/useWorkspaceFileTransfers');

        let api: ReturnType<typeof useWorkspaceFileTransfers> | null = null;
        function Test() {
            api = useWorkspaceFileTransfers({
                workspaceScope: {
                    serverId: 'server-1',
                    machineId: 'm1',
                    rootPath: '/repo',
                },
            });
            return null;
        }

        await renderScreen(<Test />);

        if (!api) throw new Error('expected hook api');

        const file = new File([new TextEncoder().encode('hello')], 'hello.txt', { type: 'text/plain' });

        let result: { ok: boolean; error?: string } | null = null;
        await act(async () => {
            result = await api!.startUploads({
                destinationDir: 'workspace/files',
                entries: [
                    {
                        kind: 'web',
                        file,
                        relativePath: 'hello.txt',
                    },
                ],
            });
        });

        expect(result).toEqual({ ok: false, error: 'Upload source reader exploded' });
        expect(uploadDaemonWorkspaceFileFromReaderMock).toHaveBeenCalledTimes(1);
        expect(uploadReaderCloseSpy).toHaveBeenCalledTimes(1);
    });

    it('finishes the exact staged file without starting a second upload', async () => {
        callDaemonWorkspaceStatFileRpcMock.mockResolvedValue({ success: true, exists: false });
        const recovery = {
            kind: 'transfer_finalize_recovery' as const,
            expiresAt: Date.now() + 60_000,
            actions: ['retry_finalize', 'discard_staged'] as const,
            isActionable: () => true,
            invoke: vi.fn(),
        };
        uploadDaemonWorkspaceFileFromReaderMock.mockResolvedValueOnce({
            success: false,
            error: 'Finalize recovery is required',
            errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
            recovery,
        });
        runTransferFinalizeRecoveryMock.mockResolvedValueOnce({
            status: 'finalized',
            response: {
                success: true,
                path: 'workspace/files/hello.txt',
                sizeBytes: 5,
                sha256: 'sha256',
            },
        });
        const { useWorkspaceFileTransfers } = await import('@/hooks/workspaces/transfers/useWorkspaceFileTransfers');

        let api: WorkspaceFileTransfersApi | null = null;
        function Test() {
            api = useWorkspaceFileTransfers({
                workspaceScope: {
                    serverId: 'server-1',
                    machineId: 'm1',
                    rootPath: '/repo',
                },
            }) as unknown as WorkspaceFileTransfersApi;
            return null;
        }
        await renderScreen(<Test />);
        const file = new File([new TextEncoder().encode('hello')], 'hello.txt', { type: 'text/plain' });

        let result: { ok: boolean; error?: string } | null = null;
        await act(async () => {
            result = await api!.startUploads({
                destinationDir: 'workspace/files',
                entries: [{ kind: 'web', file, relativePath: 'hello.txt' }],
            });
        });

        expect(result).toEqual({ ok: true });
        expect(uploadDaemonWorkspaceFileFromReaderMock).toHaveBeenCalledTimes(1);
        expect(runTransferFinalizeRecoveryMock).toHaveBeenCalledWith(expect.objectContaining({ recovery }));
    });

    it('blocks a fresh upload while finalize recovery is in flight', async () => {
        callDaemonWorkspaceStatFileRpcMock.mockResolvedValue({ success: true, exists: false });
        const recovery = {
            kind: 'transfer_finalize_recovery' as const,
            expiresAt: Date.now() + 60_000,
            actions: ['retry_finalize', 'discard_staged'] as const,
            isActionable: () => true,
            invoke: vi.fn(),
        };
        uploadDaemonWorkspaceFileFromReaderMock.mockResolvedValueOnce({
            success: false,
            error: 'Finalize recovery is required',
            errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
            recovery,
        });
        let finishRecovery!: (value: unknown) => void;
        runTransferFinalizeRecoveryMock.mockImplementationOnce(async () => await new Promise((resolve) => {
            finishRecovery = resolve;
        }));
        const { useWorkspaceFileTransfers } = await import('@/hooks/workspaces/transfers/useWorkspaceFileTransfers');
        let api: WorkspaceFileTransfersApi | null = null;
        function Test() {
            api = useWorkspaceFileTransfers({
                workspaceScope: { serverId: 'server-1', machineId: 'm1', rootPath: '/repo' },
            }) as unknown as WorkspaceFileTransfersApi;
            return null;
        }
        await renderScreen(<Test />);
        const file = new File([new TextEncoder().encode('hello')], 'hello.txt', { type: 'text/plain' });
        const input = {
            destinationDir: 'workspace/files',
            entries: [{ kind: 'web' as const, file, relativePath: 'hello.txt' }],
        };

        let firstUpload!: Promise<{ ok: boolean; error?: string }>;
        await act(async () => {
            firstUpload = api!.startUploads(input);
            await vi.waitFor(() => expect(runTransferFinalizeRecoveryMock).toHaveBeenCalledTimes(1));
        });
        await expect(api!.startUploads(input)).resolves.toEqual({
            ok: false,
            error: 'Uploads already in progress',
        });
        expect(uploadDaemonWorkspaceFileFromReaderMock).toHaveBeenCalledTimes(1);

        finishRecovery({
            status: 'finalized',
            response: {
                success: true,
                path: 'workspace/files/hello.txt',
                sizeBytes: 5,
                sha256: 'sha256',
            },
        });
        await act(async () => {
            await expect(firstUpload).resolves.toEqual({ ok: true });
        });
        expect(uploadDaemonWorkspaceFileFromReaderMock).toHaveBeenCalledTimes(1);
    });

    it('aborts an in-flight upload on true unmount and keeps late completion inert', async () => {
        callDaemonWorkspaceStatFileRpcMock.mockResolvedValue({ success: true, exists: false });
        const transfer: { signal: AbortSignal | null } = { signal: null };
        uploadDaemonWorkspaceFileFromReaderMock.mockImplementation(async (params: Readonly<{
            signal?: AbortSignal | null;
        }>) => await new Promise((resolve) => {
            transfer.signal = params.signal ?? null;
            params.signal?.addEventListener('abort', () => resolve({
                success: false,
                error: 'Upload canceled',
            }), { once: true });
        }));
        const onAfterUploadSuccess = vi.fn();
        const { useWorkspaceFileTransfers } = await import('@/hooks/workspaces/transfers/useWorkspaceFileTransfers');
        const hook = await renderHook(
            (props: Parameters<typeof useWorkspaceFileTransfers>[0]) => useWorkspaceFileTransfers(props),
            {
                initialProps: {
                    workspaceScope: { serverId: 'server-1', machineId: 'm1', rootPath: '/repo' },
                    onAfterUploadSuccess,
                },
            },
        );
        const file = new File([new TextEncoder().encode('hello')], 'hello.txt', { type: 'text/plain' });
        let pending!: Promise<{ ok: boolean; error?: string }>;
        await act(async () => {
            pending = hook.getCurrent().startUploads({
                destinationDir: 'workspace/files',
                entries: [{ kind: 'web', file, relativePath: 'hello.txt' }],
            });
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(uploadDaemonWorkspaceFileFromReaderMock).toHaveBeenCalledTimes(1));

        await hook.unmount();

        expect(transfer.signal?.aborted).toBe(true);
        await expect(pending).resolves.toEqual({ ok: false, error: 'Upload canceled' });
        expect(onAfterUploadSuccess).not.toHaveBeenCalled();
    });
});
