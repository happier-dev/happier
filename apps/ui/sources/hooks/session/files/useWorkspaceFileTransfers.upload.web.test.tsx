import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionFilesHookCommonModuleMocks } from './sessionFilesHookTestHelpers';

const uploadDaemonWorkspaceFileFromReaderMock = vi.hoisted(() => vi.fn());
const callDaemonWorkspaceStatFileRpcMock = vi.hoisted(() => vi.fn());

installSessionFilesHookCommonModuleMocks();

vi.mock('@/sync/domains/transfers/runtime/bulkTransferPipeline/daemonWorkspaceFiles', () => ({
    uploadDaemonWorkspaceFileFromReader: (...args: unknown[]) => uploadDaemonWorkspaceFileFromReaderMock(...args),
    callDaemonWorkspaceStatFileRpc: (...args: unknown[]) => callDaemonWorkspaceStatFileRpcMock(...args),
}));

describe('useWorkspaceFileTransfers upload pipeline', () => {
    beforeEach(() => {
        uploadDaemonWorkspaceFileFromReaderMock.mockReset();
        callDaemonWorkspaceStatFileRpcMock.mockReset();
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

        await act(async () => {
            await api!.startUploads({
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
    });
});
