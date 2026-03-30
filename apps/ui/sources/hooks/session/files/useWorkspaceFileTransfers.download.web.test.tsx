import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionFilesHookCommonModuleMocks } from './sessionFilesHookTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const downloadDaemonSessionFileToDestinationMock = vi.hoisted(() => vi.fn());

installSessionFilesHookCommonModuleMocks();

vi.mock('@/sync/domains/transfers/runtime/bulkTransferPipeline/daemonSessionFiles', () => ({
    downloadDaemonSessionFileToDestination: (...args: unknown[]) => downloadDaemonSessionFileToDestinationMock(...args),
}));

vi.mock('@/sync/ops', () => ({
    sessionStatFile: vi.fn(),
}));

describe('useWorkspaceFileTransfers web download cleanup', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        downloadDaemonSessionFileToDestinationMock.mockReset();
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

        downloadDaemonSessionFileToDestinationMock.mockImplementation(async (params: {
            sessionId: string;
            request: { path: string; asZip: boolean };
            destination: {
                writeBytes: (bytes: Uint8Array) => Promise<void>;
                close: () => Promise<void>;
                cleanup?: (() => Promise<void>) | null;
            };
            onInit?: ((init: { name: string; sizeBytes: number }) => Promise<void | { success: false; error: string }>) | null;
            signal?: AbortSignal | null;
            onProgress?: ((progress: { downloadedBytes: number; totalBytes: number }) => void) | null;
        }) => {
            expect(params.sessionId).toBe('session-1');
            expect(params.request).toEqual({ path: 'report.txt', asZip: false });
            await params.onInit?.({ name: 'report.txt', sizeBytes: 4 });
            await params.destination.writeBytes(new Uint8Array([1, 2, 3, 4]));
            params.onProgress?.({ downloadedBytes: 4, totalBytes: 4 });
            await params.destination.close();
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
        expect(downloadDaemonSessionFileToDestinationMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.runAllTimersAsync();
        });

        expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-download');
    });

    it('fails when downloaded bytes exceed the configured web max bytes (even if init under-reports)', async () => {
        const priorLimit = process.env.EXPO_PUBLIC_HAPPIER_FILES_DOWNLOAD_MAX_BYTES;
        process.env.EXPO_PUBLIC_HAPPIER_FILES_DOWNLOAD_MAX_BYTES = '3';

        const createObjectURL = vi.fn(() => 'blob:should-not-be-used');
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

        downloadDaemonSessionFileToDestinationMock.mockImplementation(async (params: {
            sessionId: string;
            request: { path: string; asZip: boolean };
            destination: {
                writeBytes: (bytes: Uint8Array) => Promise<void>;
                close: () => Promise<void>;
                cleanup?: (() => Promise<void>) | null;
            };
            onInit?: ((init: { name: string; sizeBytes: number }) => Promise<void | { success: false; error: string }>) | null;
            signal?: AbortSignal | null;
        }) => {
            await params.onInit?.({ name: 'big.bin', sizeBytes: 1 });
            await params.destination.writeBytes(new Uint8Array([1, 2, 3, 4]));
            if (params.signal?.aborted) {
                await params.destination.cleanup?.();
                return { ok: false, error: 'Download canceled' };
            }
            await params.destination.close();
            return { ok: true, name: 'big.bin', sizeBytes: 4 };
        });

        const { useWorkspaceFileTransfers } = await import('./useWorkspaceFileTransfers');

        let api: ReturnType<typeof useWorkspaceFileTransfers> | null = null;
        function Test() {
            api = useWorkspaceFileTransfers({ sessionId: 'session-1' });
            return null;
        }

        await renderScreen(<Test />);

        if (!api) throw new Error('expected hook api');

        let result: unknown = null;
        await act(async () => {
            result = await api!.startDownload({ path: 'big.bin', asZip: false });
        });

        expect(result).toEqual({ ok: false, error: 'File exceeds the web download size limit' });
        expect(click).toHaveBeenCalledTimes(0);
        expect(createObjectURL).toHaveBeenCalledTimes(0);
        expect(revokeObjectURL).toHaveBeenCalledTimes(0);

        process.env.EXPO_PUBLIC_HAPPIER_FILES_DOWNLOAD_MAX_BYTES = priorLimit;
    });
});
