import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionFilesHookCommonModuleMocks } from './sessionFilesHookTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const downloadDaemonWorkspaceFileToDestinationMock = vi.hoisted(() => vi.fn());

installSessionFilesHookCommonModuleMocks();

vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    downloadDaemonWorkspaceFileToDestination: (...args: unknown[]) => downloadDaemonWorkspaceFileToDestinationMock(...args),
}));

describe('useWorkspaceFileTransfers web download cleanup', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        downloadDaemonWorkspaceFileToDestinationMock.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('streams into OPFS and delays disk-backed URL cleanup until after the download is triggered', async () => {
        const diskFile = { name: 'report.txt', size: 4 } as File;
        const write = vi.fn(async (_bytes: Uint8Array) => {});
        const close = vi.fn(async () => {});
        const abort = vi.fn(async () => {});
        const removeEntry = vi.fn(async () => {});
        const createObjectURL = vi.fn(() => 'blob:test-download');
        const revokeObjectURL = vi.fn();
        const click = vi.fn();
        const remove = vi.fn();
        const appendChild = vi.fn();
        const createElement = vi.fn(() => ({
            click,
            remove,
            href: '',
            download: '',
            rel: '',
        }));

        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
        vi.stubGlobal('document', { createElement, body: { appendChild } });
        vi.stubGlobal('navigator', {
            storage: {
                getDirectory: async () => ({
                    getFileHandle: async () => ({
                        createWritable: async () => ({ write, close, abort }),
                        getFile: async () => diskFile,
                    }),
                    removeEntry,
                }),
            },
        });
        vi.stubGlobal('Blob', class Blob {
            constructor() {
                throw new Error('whole-payload Blob must not be constructed for OPFS downloads');
            }
        });

        downloadDaemonWorkspaceFileToDestinationMock.mockImplementation(async (params: {
            machineId: string;
            serverId?: string | null;
            rootPath: string;
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
            expect(params.machineId).toBe('m1');
            expect(params.serverId).toBe('server-1');
            expect(params.rootPath).toBe('/repo');
            expect(params.request).toEqual({ path: 'report.txt', asZip: false });
            await params.onInit?.({ name: 'report.txt', sizeBytes: 4 });
            await params.destination.writeBytes(new Uint8Array([1, 2, 3, 4]));
            params.onProgress?.({ downloadedBytes: 4, totalBytes: 4 });
            await params.destination.close();
            return { ok: true, name: 'report.txt', sizeBytes: 4 };
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

        await act(async () => {
            await api!.startDownload({ path: 'report.txt', asZip: false });
        });

        expect(appendChild).toHaveBeenCalledTimes(1);
        expect(click).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
        expect(createObjectURL).toHaveBeenCalledWith(diskFile);
        expect(remove).toHaveBeenCalledTimes(0);
        expect(removeEntry).toHaveBeenCalledTimes(0);
        expect(revokeObjectURL).not.toHaveBeenCalled();
        expect(downloadDaemonWorkspaceFileToDestinationMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.runAllTimersAsync();
        });

        expect(remove).toHaveBeenCalledTimes(1);
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-download');
        expect(removeEntry).toHaveBeenCalledTimes(1);
        expect(abort).not.toHaveBeenCalled();
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

        downloadDaemonWorkspaceFileToDestinationMock.mockImplementation(async (params: {
            machineId: string;
            serverId?: string | null;
            rootPath: string;
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
