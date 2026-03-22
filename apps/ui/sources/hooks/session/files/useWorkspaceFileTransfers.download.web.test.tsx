import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const downloadBulkPayloadToFileMock = vi.hoisted(() => vi.fn());
const createSessionFileTransferRpcCallerMock = vi.hoisted(() => vi.fn());
const SESSION_FILES_DOWNLOAD_INIT = 'daemon.sessionFiles.download.init';
const SESSION_FILES_DOWNLOAD_CHUNK = 'daemon.sessionFiles.download.chunk';
const SESSION_FILES_DOWNLOAD_FINALIZE = 'daemon.sessionFiles.download.finalize';
const SESSION_FILES_DOWNLOAD_ABORT = 'daemon.sessionFiles.download.abort';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            Platform: {
                OS: 'web',
            },
        }
    );
});

vi.mock('@/sync/domains/transfers/runtime/bulkTransferPipeline', () => ({
    downloadBulkPayloadToFile: (...args: unknown[]) => downloadBulkPayloadToFileMock(...args),
}));

vi.mock('@/sync/domains/transfers/runtime/sessionFileTransferRpcCaller', () => ({
    createSessionFileTransferRpcCaller: (...args: unknown[]) => createSessionFileTransferRpcCallerMock(...args),
}));

vi.mock('@/sync/ops', () => ({
    sessionStatFile: vi.fn(),
}));

describe('useWorkspaceFileTransfers web download cleanup', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        downloadBulkPayloadToFileMock.mockReset();
        createSessionFileTransferRpcCallerMock.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('delays blob URL revocation until after the download is triggered', async () => {
        const createObjectURL = vi.fn(() => 'blob:test-download');
        const revokeObjectURL = vi.fn();
        const click = vi.fn();
        const createElement = vi.fn(() => ({
            click,
            href: '',
            download: '',
            rel: '',
        }));

        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
        vi.stubGlobal('document', { createElement });
        vi.stubGlobal('Blob', class Blob {
            constructor(_parts?: unknown[], _options?: Record<string, unknown>) {}
        });

        let downloadRpcCallCount = 0;
        createSessionFileTransferRpcCallerMock.mockReturnValue({
            call: async ({ machineMethod }: { machineMethod: string }) => {
                downloadRpcCallCount += 1;
                if (downloadRpcCallCount === 1) {
                    expect(machineMethod).toBe(SESSION_FILES_DOWNLOAD_INIT);
                    return {
                        success: true,
                        downloadId: 'download-1',
                        chunkSizeBytes: 4,
                        sizeBytes: 4,
                        name: 'report.txt',
                    };
                }
                expect([SESSION_FILES_DOWNLOAD_CHUNK, SESSION_FILES_DOWNLOAD_FINALIZE, SESSION_FILES_DOWNLOAD_ABORT]).toContain(machineMethod);
                return { success: true };
            },
        });

        downloadBulkPayloadToFileMock.mockImplementation(async (params: {
            destination: {
                writeBytes: (bytes: Uint8Array) => Promise<void>;
                close: () => Promise<void>;
                cleanup?: (() => Promise<void>) | null;
            };
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
        }) => {
            const init = await params.init({ recipientPublicKeyBase64: 'recipient-public-key' });
            if (!init.success) {
                return init;
            }
            await params.destination.writeBytes(new Uint8Array([1, 2, 3, 4]));
            await params.readChunk({ downloadId: init.downloadId, index: 0 });
            await params.finalize({ downloadId: init.downloadId });
            return { ok: true, name: 'report.txt', sizeBytes: 4 };
        });

        const { useWorkspaceFileTransfers } = await import('./useWorkspaceFileTransfers');

        let api: ReturnType<typeof useWorkspaceFileTransfers> | null = null;
        function Test() {
            api = useWorkspaceFileTransfers({ sessionId: 'session-1' });
            return null;
        }

        await renderScreen(<Test />);

        if (!api) throw new Error('expected hook api');

        await act(async () => {
            await api!.startDownload({ path: 'report.txt', asZip: false });
        });

        expect(click).toHaveBeenCalledTimes(1);
        expect(revokeObjectURL).not.toHaveBeenCalled();
        expect(downloadBulkPayloadToFileMock).toHaveBeenCalledTimes(1);
        expect(createSessionFileTransferRpcCallerMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
        });

        await act(async () => {
            await vi.runAllTimersAsync();
        });

        expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-download');
    });
});
