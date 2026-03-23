import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

const uploadDaemonSessionFileFromReaderMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
        },
    });
});

vi.mock('@/sync/domains/transfers/runtime/bulkTransferPipeline/daemonSessionFiles', () => ({
    uploadDaemonSessionFileFromReader: (...args: unknown[]) => uploadDaemonSessionFileFromReaderMock(...args),
}));

vi.mock('@/sync/ops', () => ({
    sessionStatFile: vi.fn(async () => ({ success: true, exists: false })),
}));

describe('useWorkspaceFileTransfers upload pipeline', () => {
    beforeEach(() => {
        uploadDaemonSessionFileFromReaderMock.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('uploads files through the canonical bulk pipeline helper', async () => {
        uploadDaemonSessionFileFromReaderMock.mockImplementation(async (params: {
            sessionId: string;
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
            expect(params.sessionId).toBe('session-1');
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

        const { useWorkspaceFileTransfers } = await import('./useWorkspaceFileTransfers');

        let api: ReturnType<typeof useWorkspaceFileTransfers> | null = null;
        function Test() {
            api = useWorkspaceFileTransfers({ sessionId: 'session-1' });
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

        expect(uploadDaemonSessionFileFromReaderMock).toHaveBeenCalledTimes(1);
    });
});
