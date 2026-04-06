import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionFilesHookCommonModuleMocks } from './sessionFilesHookTestHelpers';

const uploadDaemonWorkspaceFileFromReaderMock = vi.hoisted(() => vi.fn());
const callDaemonWorkspaceStatFileRpcMock = vi.hoisted(() => vi.fn());
const openLocalUploadSourceReaderMock = vi.hoisted(() => vi.fn());
const uploadReaderCloseSpy = vi.hoisted(() => vi.fn());

installSessionFilesHookCommonModuleMocks();

vi.mock('@/sync/domains/transfers/runtime/transferSubstrate', () => ({
    uploadDaemonWorkspaceFileFromReader: (...args: unknown[]) => uploadDaemonWorkspaceFileFromReaderMock(...args),
    callDaemonWorkspaceStatFileRpc: (...args: unknown[]) => callDaemonWorkspaceStatFileRpcMock(...args),
}));

vi.mock('@/sync/runtime/files/localUploadSourceReader', () => ({
    openLocalUploadSourceReader: (...args: unknown[]) => openLocalUploadSourceReaderMock(...args),
    resolveLocalUploadSourceSizeBytes: async (source: { kind: 'web'; file: File }) => source.file.size,
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
});
