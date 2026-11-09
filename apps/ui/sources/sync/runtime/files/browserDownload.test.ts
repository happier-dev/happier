import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExpoFileSystemFileMock } from '@/dev/testkit/mocks/expoFileSystem';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createBrowserControlState, dispatchBrowserControlCommand } from '@/sync/domains/browser/control';
import { registerBrowserRuntimeControlAdapter } from '@/sync/domains/browser/actions/runtimeControlRegistry';
import { encodeBase64 } from '@/encryption/base64';

const boundary = vi.hoisted(() => ({ fileSystem: null as ReturnType<typeof createExpoFileSystemFileMock> | null,
    choose: vi.fn<(input: { fileUri: string }) => Promise<{ canceled: boolean }>>() }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'android' }));
vi.mock('expo-file-system', async () => {
    boundary.fileSystem = (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock();
    return boundary.fileSystem.module;
});
// Android's file chooser is the OS boundary; the real sink and byte handoff stay in the path.
vi.mock('./nativeFileActions', () => ({ performAndroidFileAction: boundary.choose }));

const reference = { machineId: 'machine', browserSessionId: 'browser', viewId: 'view', downloadId: 'download' };
const scope = { serverId: 'home', accountId: 'owner' };
const context = { surface: 'ui', authority: 'present_user', runtimeAccountId: scope.accountId,
    serverId: scope.serverId, actionCaller: { kind: 'host' } } as const;
const download = { downloadId: reference.downloadId, name: 'binary.dat', receivedBytes: 4, totalBytes: 4, state: 'completed' } as const;

beforeEach(async () => {
    await import('expo-file-system');
    boundary.fileSystem!.files.clear();
    boundary.choose.mockReset().mockResolvedValue({ canceled: false });
});

describe('Browser download file handoff', () => {
    it('saves binary ranges through the real files.save Action, registered Browser owner and native sink', async () => {
        const { saveBrowserDownload, saveBrowserDownloadRanges } = await import('./browserDownload');
        const bytes = new Uint8Array([0, 255, 128, 42]);
        const written: number[][] = [];
        boundary.choose.mockImplementation(async ({ fileUri }) => {
            written.push([...boundary.fileSystem!.files.get(fileUri)!]); return { canceled: false };
        });
        const state = dispatchBrowserControlCommand(createBrowserControlState(), { kind: 'openView', commandId: 'open',
            browserSessionId: 'browser', viewId: 'view', platform: 'web', focus: true,
            target: { kind: 'localServicePreview', targetId: 'target', sessionId: 'browser', machineId: 'machine' },
            currentUrl: 'https://example.com' }).state;
        const release = registerBrowserRuntimeControlAdapter({ browserSessionId: 'browser', control: {
            accountLifetime: { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            readState: () => state, applyDispatchResult() {},
            saveDownload: args => saveBrowserDownloadRanges({ download, fileName: args.fileName, signal: args.signal,
                maxFrameBytes: 2, request: async event => ({ kind: 'download', downloadId: download.downloadId,
                    name: download.name, offset: event.offset, dataBase64: encodeBase64(bytes.slice(event.offset, event.offset + event.byteLength)),
                    eof: event.offset + event.byteLength >= bytes.length }) }),
        } });
        try {
            const actions = createActionExecutor(createActionExecutorBoundaryFixture({
                saveClientBrowserDownload: args => saveBrowserDownload(args, scope),
            }));
            expect(await actions.execute('files.save', { fileName: 'binary.dat', source: { kind: 'browserDownload', reference } }, context))
                .toEqual({ ok: true, result: { status: 'saved' } });
            expect(written).toEqual([[...bytes]]);
            expect(boundary.fileSystem!.files.size).toBe(0);
            expect(await saveBrowserDownload({ reference, fileName: 'binary.dat' }, { ...scope, accountId: 'other' }))
                .toMatchObject({ ok: false, errorCode: 'browser_download_unavailable' });
            expect(written).toHaveLength(1);
        } finally { release(); }
    });

    it('refuses unfinished downloads, preserves range failures and cleans partial files on cancellation', async () => {
        const { saveBrowserDownloadRanges } = await import('./browserDownload');
        const request = vi.fn(async () => { throw new Error('download_unavailable'); });
        await expect(saveBrowserDownloadRanges({ download: { ...download, state: 'inProgress' }, request }))
            .rejects.toThrow('download_not_completed');
        expect(request).not.toHaveBeenCalled();
        await expect(saveBrowserDownloadRanges({ download, request })).rejects.toThrow('download_unavailable');
        expect(boundary.fileSystem!.files.size).toBe(0);
        const controller = new AbortController();
        await expect(saveBrowserDownloadRanges({ download, signal: controller.signal, request: async () => {
            controller.abort();
            return { kind: 'download', downloadId: download.downloadId, name: download.name, offset: 0,
                dataBase64: encodeBase64(new Uint8Array([0, 255])), eof: false };
        } })).rejects.toThrow();
        expect(boundary.fileSystem!.files.size).toBe(0);
        expect(boundary.choose).not.toHaveBeenCalled();
    });

    it('reports chooser cancellation and cleans its completed cache file', async () => {
        const { saveBrowserDownloadRanges } = await import('./browserDownload');
        boundary.choose.mockResolvedValue({ canceled: true });
        await expect(saveBrowserDownloadRanges({ download, request: async () => ({ kind: 'download', downloadId: download.downloadId,
            name: download.name, offset: 0, dataBase64: encodeBase64(new Uint8Array([0, 255, 128, 42])), eof: true }) }))
            .resolves.toEqual({ status: 'canceled' });
        expect(boundary.fileSystem!.files.size).toBe(0);
    });
});
