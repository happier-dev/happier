import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { installSessionFilesHookCommonModuleMocks } from './sessionFilesHookTestHelpers';

const downloadDaemonWorkspaceFileToDestinationMock = vi.hoisted(() => vi.fn());
const nativeOpenSpy = vi.hoisted(() => vi.fn());
const nativeCloseSpy = vi.hoisted(() => vi.fn());
const nativeDeleteSpy = vi.hoisted(() => vi.fn());

installSessionFilesHookCommonModuleMocks({
    reactNative: installReactNativeWebMock({
        Platform: {
            OS: 'native',
        },
    }),
});

vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    downloadDaemonWorkspaceFileToDestination: (...args: unknown[]) => downloadDaemonWorkspaceFileToDestinationMock(...args),
}));

vi.mock('expo-file-system', () => {
    class FakeDirectory {
        uri: string;
        constructor(parent: { uri: string } | string, name?: string) {
            const parentUri = typeof parent === 'string' ? parent : parent.uri;
            this.uri = name ? `${parentUri.replace(/\/+$/, '')}/${name}` : parentUri;
        }
        create() {}
    }

    class FakeFileHandle {
        offset: number | null = 0;
        size: number | null = 4;
        close() {
            nativeCloseSpy();
        }
        readBytes(_length: number): Uint8Array {
            return new Uint8Array([1, 2, 3, 4]);
        }
        writeBytes(_bytes: Uint8Array): void {}
    }

    class FakeFile {
        uri: string;
        constructor(parent: { uri: string } | string, name?: string) {
            const parentUri = typeof parent === 'string' ? parent : parent.uri;
            this.uri = name ? `${parentUri.replace(/\/+$/, '')}/${name}` : parentUri;
        }
        create() {}
        open() {
            nativeOpenSpy();
            return new FakeFileHandle();
        }
        delete() {
            nativeDeleteSpy();
        }
    }

    return {
        Directory: FakeDirectory,
        File: FakeFile,
        Paths: { cache: { uri: 'file:///cache' } },
    };
});

describe('useWorkspaceFileTransfers native download cleanup', () => {
    beforeEach(() => {
        downloadDaemonWorkspaceFileToDestinationMock.mockReset();
        nativeOpenSpy.mockReset();
        nativeCloseSpy.mockReset();
        nativeDeleteSpy.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unmock('expo-sharing');
    });

    it('cleans up the native download sink when the canonical helper returns a failure', async () => {
        downloadDaemonWorkspaceFileToDestinationMock.mockImplementation(async (params: {
            destination: {
                writeBytes: (bytes: Uint8Array) => Promise<void>;
                close: () => Promise<void>;
                cleanup?: (() => Promise<void>) | null;
            };
            onInit?: ((init: { name: string; sizeBytes: number }) => Promise<void | { success: false; error: string }>) | null;
        }) => {
            await params.onInit?.({ name: 'report.txt', sizeBytes: 4 });
            await params.destination.writeBytes(new Uint8Array([1, 2, 3, 4]));
            return { ok: false, error: 'Download finalize failed' };
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

        let result: { ok: boolean; error?: string } | null = null;
        await act(async () => {
            result = await api!.startDownload({ path: 'report.txt', asZip: false });
        });

        expect(result).toEqual({ ok: false, error: 'Download finalize failed' });
        expect(nativeOpenSpy).toHaveBeenCalledTimes(1);
        expect(nativeCloseSpy).toHaveBeenCalledTimes(1);
        expect(nativeDeleteSpy).toHaveBeenCalledTimes(2);
    });

    it('cleans up the native download sink after a successful share', async () => {
        const shareAsync = vi.fn(async () => undefined);
        vi.doMock('expo-sharing', () => ({
            isAvailableAsync: async () => true,
            shareAsync,
        }));

        downloadDaemonWorkspaceFileToDestinationMock.mockImplementation(async (params: {
            destination: {
                writeBytes: (bytes: Uint8Array) => Promise<void>;
                close: () => Promise<void>;
            };
            onInit?: ((init: { name: string; sizeBytes: number }) => Promise<void | { success: false; error: string }>) | null;
        }) => {
            await params.onInit?.({ name: 'report.txt', sizeBytes: 4 });
            await params.destination.writeBytes(new Uint8Array([1, 2, 3, 4]));
            await params.destination.close();
            return { ok: true, name: 'report.txt' };
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

        let result: { ok: boolean; error?: string } | null = null;
        await act(async () => {
            result = await api!.startDownload({ path: 'report.txt', asZip: false });
        });

        expect(result).toEqual({ ok: true });
        expect(shareAsync).toHaveBeenCalledWith('file:///cache/happier-downloads/report.txt');
        expect(nativeOpenSpy).toHaveBeenCalledTimes(1);
        expect(nativeCloseSpy).toHaveBeenCalledTimes(1);
        expect(nativeDeleteSpy).toHaveBeenCalledTimes(2);
    });

    it.each(['cancel', 'unmount'] as const)('does not share after native availability settles following %s', async (interruption) => {
        const availabilityStarted = createDeferred<void>();
        const availability = createDeferred<boolean>();
        const isAvailableAsync = vi.fn(async () => {
            availabilityStarted.resolve();
            return await availability.promise;
        });
        const shareAsync = vi.fn(async () => undefined);
        vi.doMock('expo-sharing', () => ({
            isAvailableAsync,
            shareAsync,
        }));

        downloadDaemonWorkspaceFileToDestinationMock.mockImplementation(async (params: {
            destination: {
                writeBytes: (bytes: Uint8Array) => Promise<void>;
                close: () => Promise<void>;
            };
            onInit?: ((init: { name: string; sizeBytes: number }) => Promise<void | { success: false; error: string }>) | null;
        }) => {
            await params.onInit?.({ name: 'report.txt', sizeBytes: 4 });
            await params.destination.writeBytes(new Uint8Array([1, 2, 3, 4]));
            await params.destination.close();
            return { ok: true, name: 'report.txt' };
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

        const screen = await renderScreen(<Test />);

        if (!api) throw new Error('expected hook api');

        let download: Promise<{ ok: boolean; error?: string; canceled?: true }> | null = null;
        await act(async () => {
            download = api!.startDownload({ path: 'report.txt', asZip: false });
            await availabilityStarted.promise;
        });

        await act(async () => {
            if (interruption === 'cancel') {
                api!.cancelDownload();
            } else {
                await screen.unmount();
            }
            availability.resolve(true);
        });

        if (!download) throw new Error('expected download promise');
        await expect(download).resolves.toEqual({ ok: false, error: 'Download canceled', canceled: true });
        expect(isAvailableAsync).toHaveBeenCalledTimes(1);
        expect(shareAsync).not.toHaveBeenCalled();
        expect(nativeOpenSpy).toHaveBeenCalledTimes(1);
        expect(nativeCloseSpy).toHaveBeenCalledTimes(1);
        expect(nativeDeleteSpy).toHaveBeenCalledTimes(2);
    });
});
