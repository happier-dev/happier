import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
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
        constructor(uri: string) {
            this.uri = uri;
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
        File: FakeFile,
        cacheDirectory: 'file:///cache',
        makeDirectoryAsync: async () => undefined,
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
        expect(nativeDeleteSpy).toHaveBeenCalledTimes(1);
    });
});
