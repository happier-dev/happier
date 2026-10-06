import * as React from 'react';
import { Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkspaceFileDownloadHarness } from '@/dev/testkit/harness/workspaceFileDownloadHarness';

const fs = vi.hoisted(async () => {
    const { createExpoFileSystemFileMock } = await import('@/dev/testkit/mocks/expoFileSystem');
    return createExpoFileSystemFileMock();
});
const actions = vi.hoisted(() => ({ saveFile: vi.fn(), openFile: vi.fn(), shareFile: vi.fn(), iosShare: vi.fn() }));
vi.mock('expo-file-system', async () => (await fs).module);
vi.mock('expo-modules-core', async importOriginal => ({
    ...await importOriginal<typeof import('expo-modules-core')>(),
    requireOptionalNativeModule: (name: string) => name === 'HappierFileActions' ? actions : null,
}));
vi.mock('expo-sharing', () => ({ isAvailableAsync: async () => true, shareAsync: actions.iosShare }));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: key => key });
});

import { useWorkspaceFileTransfers } from '@/hooks/workspaces/transfers/useWorkspaceFileTransfers';

describe('workspace file native download actions through the prepared carrier', () => {
    const previousPlatform = Platform.OS;
    let harness: Awaited<ReturnType<typeof createWorkspaceFileDownloadHarness>>;
    beforeEach(async () => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        vi.clearAllMocks();
        (await fs).files.clear();
        actions.saveFile.mockResolvedValue({ canceled: false });
        actions.openFile.mockResolvedValue(undefined);
        actions.shareFile.mockResolvedValue(undefined);
        actions.iosShare.mockResolvedValue(undefined);
        harness = await createWorkspaceFileDownloadHarness({ name: 'recording.mp4' });
    });
    afterEach(async () => {
        standardCleanup();
        await harness?.reset();
        Object.defineProperty(Platform, 'OS', { configurable: true, value: previousPlatform });
    });
    async function renderTransfers() {
        let api: ReturnType<typeof useWorkspaceFileTransfers> | undefined;
        function Test() { api = useWorkspaceFileTransfers({ workspaceScope: harness.scope }); return null; }
        const screen = await renderScreen(<Test />);
        if (!api) throw new Error('Expected transfer hook');
        return { screen, api: () => api! };
    }

    it.each(['open', 'share'] as const)('retains granted bytes if cancellation arrives while native %s completion is pending', async action => {
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const nativeAction = action === 'open' ? actions.openFile : actions.shareFile;
        nativeAction.mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
        });
        const transfers = await renderTransfers();
        let pending: ReturnType<ReturnType<typeof useWorkspaceFileTransfers>['startDownload']> | undefined;
        await act(async () => {
            pending = transfers.api().startDownload({ path: 'recording.mp4', asZip: false, action });
            await entered.promise;
        });
        expect([...((await fs).files.values())]).toEqual([[1, 2, 3]]);
        await act(async () => {
            transfers.api().cancelDownload();
            release.resolve();
            await expect(pending).resolves.toMatchObject({ ok: false, canceled: true });
        });
        expect([...((await fs).files.values())]).toEqual([[1, 2, 3]]);
    });

    it('reports preparation as busy before a native destination is allocated', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = await TokenStorage.getCredentials();
        const entered = createDeferred<void>();
        const released = createDeferred<typeof credentials>();
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockImplementationOnce(async () => {
            entered.resolve();
            return await released.promise;
        });
        const transfers = await renderTransfers();
        let result: ReturnType<ReturnType<typeof useWorkspaceFileTransfers>['startDownload']> | undefined;
        await act(async () => { result = transfers.api().startDownload({ path: 'recording.mp4', asZip: false }); await entered.promise; });
        try {
            expect(transfers.api().downloadState.status).toBe('downloading');
            expect((await fs).files.size).toBe(0);
        } finally {
            await act(async () => { released.resolve(credentials); await result; });
        }
    });

    it('saves by default using the original display name and deletes only its completed cache file', async () => {
        const transfers = await renderTransfers();
        await act(async () => { expect(await transfers.api().startDownload({ path: 'recording.mp4', asZip: false })).toEqual({ ok: true }); });
        expect(actions.saveFile).toHaveBeenCalledWith(expect.stringMatching(/^file:\/\/\/cache\/happier-downloads\/.*\.mp4$/), 'recording.mp4');
        expect((await fs).files.size).toBe(0);
        expect(transfers.api().downloadState.status).toBe('done');
    });

    it.each(['open', 'share'] as const)('offers %s through the native action and retains the readable granted cache file', async action => {
        const transfers = await renderTransfers();
        await act(async () => { expect(await transfers.api().startDownload({ path: 'recording.mp4', asZip: false, action })).toEqual({ ok: true }); });
        const selected = action === 'open' ? actions.openFile : actions.shareFile;
        expect(selected).toHaveBeenCalledWith(expect.any(String), 'recording.mp4');
        expect([...((await fs).files.values())]).toEqual([[1, 2, 3]]);
        expect(actions.saveFile).not.toHaveBeenCalled();
    });

    it('treats a dismissed document picker as cancellation and releases its cache', async () => {
        actions.saveFile.mockResolvedValue({ canceled: true });
        const transfers = await renderTransfers();
        await act(async () => { expect(await transfers.api().startDownload({ path: 'recording.mp4', asZip: false })).toMatchObject({ ok: false, canceled: true }); });
        expect(transfers.api().downloadState.status).toBe('canceled');
        expect((await fs).files.size).toBe(0);
    });

    it('allows the next download after canceled-picker cache cleanup rejects', async () => {
        actions.saveFile.mockResolvedValueOnce({ canceled: true });
        (await fs).deleteFile.mockImplementationOnce(() => { throw new Error('Cache deletion failed'); });
        const transfers = await renderTransfers();
        await act(async () => {
            await expect(transfers.api().startDownload({ path: 'recording.mp4', asZip: false })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('Cache deletion failed') });
        });
        expect(transfers.api().downloadState).toEqual({ status: 'error', error: expect.stringContaining('Cache deletion failed') });
        await act(async () => {
            expect(await transfers.api().startDownload({ path: 'recording.mp4', asZip: false })).toEqual({ ok: true });
        });
        expect(actions.saveFile).toHaveBeenCalledTimes(2);
    });

    it('reports an iOS sharing rejection and releases its cache', async () => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        actions.iosShare.mockRejectedValueOnce(new Error('Share sheet failed'));
        const transfers = await renderTransfers();
        await act(async () => {
            expect(await transfers.api().startDownload({ path: 'recording.mp4', asZip: false })).toMatchObject({ ok: false });
        });
        expect(transfers.api().downloadState.status).toBe('error');
        expect((await fs).files.size).toBe(0);
    });

    it('reports a native save failure and releases its cache', async () => {
        actions.saveFile.mockRejectedValue(new Error('Document write failed'));
        const transfers = await renderTransfers();
        await act(async () => { expect(await transfers.api().startDownload({ path: 'recording.mp4', asZip: false })).toEqual({ ok: false, error: 'Document write failed' }); });
        expect(transfers.api().downloadState).toEqual({ status: 'error', error: 'Document write failed' });
        expect((await fs).files.size).toBe(0);
    });

    it('keeps the iOS share flow and releases its temporary cache', async () => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        const transfers = await renderTransfers();
        await act(async () => { expect(await transfers.api().startDownload({ path: 'recording.mp4', asZip: false })).toEqual({ ok: true }); });
        expect(actions.iosShare).toHaveBeenCalledWith(expect.stringMatching(/\.mp4$/), undefined);
        expect(actions.saveFile).not.toHaveBeenCalled();
        expect((await fs).files.size).toBe(0);
    });

    it('does not perform an OS action when a pending encrypted read settles after cancel', async () => {
        const deferred = harness.deferNextChunk();
        const transfers = await renderTransfers();
        let result: ReturnType<ReturnType<typeof useWorkspaceFileTransfers>['startDownload']> | undefined;
        await act(async () => { result = transfers.api().startDownload({ path: 'recording.mp4', asZip: false }); await deferred.entered; });
        await act(async () => {
            transfers.api().cancelDownload(); deferred.release();
            await expect(result).resolves.toMatchObject({ ok: false, canceled: true });
        });
        expect(actions.saveFile).not.toHaveBeenCalled();
        expect((await fs).files.size).toBe(0);
    });
});
