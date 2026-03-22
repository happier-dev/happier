import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

const uploadBulkPayloadFromFileMock = vi.hoisted(() => vi.fn());
const createSessionFileTransferRpcCallerMock = vi.hoisted(() => vi.fn());
const SESSION_FILES_UPLOAD_INIT = 'daemon.sessionFiles.upload.init';
const SESSION_FILES_UPLOAD_CHUNK = 'daemon.sessionFiles.upload.chunk';
const SESSION_FILES_UPLOAD_FINALIZE = 'daemon.sessionFiles.upload.finalize';
const SESSION_FILES_UPLOAD_ABORT = 'daemon.sessionFiles.upload.abort';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
        },
    });
});

vi.mock('@/sync/domains/transfers/runtime/bulkTransferPipeline', () => ({
    uploadBulkPayloadFromFile: (...args: unknown[]) => uploadBulkPayloadFromFileMock(...args),
}));

vi.mock('@/sync/domains/transfers/runtime/sessionFileTransferRpcCaller', () => ({
    createSessionFileTransferRpcCaller: (...args: unknown[]) => createSessionFileTransferRpcCallerMock(...args),
}));

vi.mock('@/sync/ops', () => ({
    sessionStatFile: vi.fn(async () => ({ success: true, exists: false })),
}));

describe('useWorkspaceFileTransfers upload pipeline', () => {
    beforeEach(() => {
        uploadBulkPayloadFromFileMock.mockReset();
        createSessionFileTransferRpcCallerMock.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('uploads files through the canonical bulk pipeline helper', async () => {
        createSessionFileTransferRpcCallerMock.mockReturnValue({
            call: async ({ machineMethod }: { machineMethod: string }) => {
                if (machineMethod === SESSION_FILES_UPLOAD_INIT) {
                    return {
                        success: true,
                        uploadId: 'upload-1',
                        chunkSizeBytes: 4,
                        recipientPublicKeyBase64: 'recipient-public-key',
                    };
                }
                if (machineMethod === SESSION_FILES_UPLOAD_CHUNK) {
                    return { success: true };
                }
                if (machineMethod === SESSION_FILES_UPLOAD_FINALIZE) {
                    return {
                        success: true,
                        path: 'workspace/files/hello.txt',
                        sizeBytes: 5,
                        sha256: 'sha256',
                    };
                }
                if (machineMethod === SESSION_FILES_UPLOAD_ABORT) {
                    return { success: true };
                }
                throw new Error(`unexpected method ${machineMethod}`);
            },
        });

        uploadBulkPayloadFromFileMock.mockImplementation(async (params: {
            fileReader: {
                sizeBytes: number;
                readBytes: (offset: number, length: number) => Promise<Uint8Array>;
                close: () => Promise<void>;
            };
            init: () => Promise<{
                success: true;
                uploadId: string;
                chunkSizeBytes: number;
                recipientPublicKeyBase64: string;
            } | {
                success: false;
                error: string;
            }>;
            sendChunk: (request: {
                uploadId: string;
                index: number;
                payloadBase64: string;
                encryptedDataKeyEnvelopeBase64: string;
            }) => Promise<{ success: boolean; error?: string }>;
            finalize: (request: { uploadId: string }) => Promise<{ success: true; path: string; sizeBytes: number; sha256: string } | { success: false; error: string }>;
        }) => {
            expect(params.fileReader.sizeBytes).toBe(5);
            await params.fileReader.readBytes(0, 5);
            const init = await params.init();
            if (!init.success) {
                return init;
            }
            await params.sendChunk({
                uploadId: init.uploadId,
                index: 0,
                payloadBase64: Buffer.from('hello').toString('base64'),
                encryptedDataKeyEnvelopeBase64: Buffer.from('envelope').toString('base64'),
            });
            return await params.finalize({ uploadId: init.uploadId });
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

        expect(uploadBulkPayloadFromFileMock).toHaveBeenCalledTimes(1);
        expect(createSessionFileTransferRpcCallerMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            sessionRpcTransferSizeBytes: 5,
        });
    });
});
