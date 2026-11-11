import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createDeferred, renderHook } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createWorkspaceFileDownloadHarness } from '@/dev/testkit/harness/workspaceFileDownloadHarness';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { Modal } from '@/modal';
import type { DesktopFileInvoke } from '@/sync/runtime/files/openInDefaultApp';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { OS: 'web' } }));
// The real ModalProvider graph loads the socket client before the harness installs its boundary.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

const { useWorkspaceFileTransfers } = await import('@/hooks/workspaces/transfers/useWorkspaceFileTransfers');

describe('useWorkspaceFileTransfers web download cleanup', () => {
    let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
    let harness: Awaited<ReturnType<typeof createWorkspaceFileDownloadHarness>>;

    beforeEach(async () => {
        browser = await installBrowserRuntimeForTests({ url: 'http://localhost/' });
        harness = await createWorkspaceFileDownloadHarness({ name: 'report.txt', bytes: new Uint8Array([1, 2, 3, 4]) });
    });

    afterEach(async () => {
        await act(async () => { await harness?.reset(); });
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        browser?.restore();
    });

    async function renderTransfers() {
        return await renderHook(() => useWorkspaceFileTransfers({ workspaceScope: harness.scope }));
    }

    function installTauriFileBoundary(fileInvoke: DesktopFileInvoke) {
        const secureStorage = createDesktopSecureStorageBoundary();
        // Recognizing the desktop host also selects OS credential custody. Keep
        // that real Account path alive with the canonical secure-storage port.
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command.startsWith('desktop_secure_storage_')) return await secureStorage.invoke(command, args);
            // Desktop uses these IPC commands instead of the mobile SDK port
            // already installed by the transfer harness. Routing, grants and
            // encrypted HTTP bytes still pass through their real owners.
            if (command === 'iroh_get_availability') return { available: true };
            if (command === 'iroh_get_application_endpoint') return { endpointId: 'b'.repeat(64) };
            if (command === 'iroh_start_machine_tunnel') return { leaseId: 'desktop-file-transfer', localPort: 48126 };
            if (command === 'iroh_stop_machine_tunnel') return;
            return await fileInvoke(command, args);
        });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        return invoke;
    }

    it('downloads held complete bytes while the Machine is unavailable without opening a transfer', async () => {
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cached-file');
        const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const click = vi.spyOn(browser.window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const hook = await renderHook(() => useWorkspaceFileTransfers({ workspaceScope: null }));
        await act(async () => {
            await expect(hook.getCurrent().startDownload({ path: 'report.txt', asZip: false,
                cachedContent: { bytes: new Uint8Array([97, 98]), fileName: 'report.txt', mimeType: 'text/plain' },
            })).resolves.toEqual({ ok: true });
        });
        expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
        expect(click).toHaveBeenCalled();
        expect(harness.rpcRequests).toHaveLength(0);
        // The delayed URL release settles here, not inside a later test.
        await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:cached-file'), { timeout: 2_000 });
    });

    it('requires a workspace for ZIP creation even when complete file bytes are held', async () => {
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:workspace-archive');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        vi.spyOn(browser.window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const cachedContent = { bytes: new Uint8Array([0, 255, 42]), fileName: 'report.txt', mimeType: 'text/plain' };
        const hook = await renderHook(() => useWorkspaceFileTransfers({ workspaceScope: null }));
        await act(async () => {
            await expect(hook.getCurrent().startDownload({ path: 'report.txt', asZip: true, cachedContent }))
                .resolves.toEqual({ ok: false, error: 'Workspace scope not available' });
        });
        const connected = await renderTransfers();
        await act(async () => {
            await expect(connected.getCurrent().startDownload({ path: 'report.txt', asZip: true, cachedContent }))
                .resolves.toEqual({ ok: true });
        });
        expect(harness.rpcRequests).toContainEqual(expect.objectContaining({ method: 'daemon.filesystem.download',
            payload: expect.objectContaining({ input: expect.objectContaining({ asZip: true }) }) }));
    });

    it('streams a Tauri open into the app-owned temp sink and hands its path to the scoped opener', async () => {
        const bytes: number[] = [];
        const path = '/tmp/happier-downloads/file-123/report.txt';
        const invoke = installTauriFileBoundary(async (command, args) => {
            if (command === 'desktop_download_cache_create') return path;
            if (command === 'desktop_download_cache_write') bytes.push(...args!.bytes as number[]);
        });
        const click = vi.spyOn(browser.window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const hook = await renderTransfers();
        await act(async () => {
            await expect(hook.getCurrent().startDownload({ path: 'report.txt', asZip: false, action: 'open' }))
                .resolves.toEqual({ ok: true });
        });
        expect(bytes).toEqual([1, 2, 3, 4]);
        expect(invoke).toHaveBeenCalledWith('plugin:opener|open_path', { path });
        expect(invoke).not.toHaveBeenCalledWith('desktop_download_cache_remove', expect.anything());
        expect(click).not.toHaveBeenCalled();
    });

    it('removes the Tauri temp file when its default handler fails', async () => {
        const path = '/tmp/happier-downloads/file-456/report.txt';
        const invoke = installTauriFileBoundary(async (command) => {
            if (command === 'desktop_download_cache_create') return path;
            if (command === 'plugin:opener|open_path') throw new Error('No handler');
        });
        vi.spyOn(browser.window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const hook = await renderTransfers();
        await act(async () => {
            await expect(hook.getCurrent().startDownload({ path: 'report.txt', asZip: false, action: 'open' }))
                .resolves.toEqual({ ok: false, error: 'No handler' });
        });
        expect(invoke).toHaveBeenCalledWith('desktop_download_cache_remove', { path });
    });

    it('opens an admitted PDF in a tab after its bytes arrive, offers a new press when blocked, and downloads HTML', async () => {
        await harness.reset();
        harness = await createWorkspaceFileDownloadHarness({ name: 'spec.pdf', bytes: new Uint8Array([37, 80, 68, 70]) });
        const tab = { opener: {} as unknown };
        const open = vi.spyOn(browser.window, 'open').mockImplementation(() => tab as unknown as Window);
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pdf-tab');
        const click = vi.spyOn(browser.window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const alert = vi.mocked(Modal.alert);
        alert.mockClear();
        const hook = await renderTransfers();

        let pending!: ReturnType<ReturnType<typeof useWorkspaceFileTransfers>['startDownload']>;
        await act(async () => { pending = hook.getCurrent().startDownload({ path: 'spec.pdf', asZip: false, action: 'open' }); });
        await act(async () => { await expect(pending).resolves.toEqual({ ok: true }); });
        // Happier stays in front while the transfer runs; the tab opens with the finished bytes.
        expect(open).toHaveBeenCalledExactlyOnceWith('blob:pdf-tab', '_blank');
        expect(tab.opener).toBeNull();
        expect(click).not.toHaveBeenCalled();

        // The press expired before the bytes arrived: the person gets a new press for the same file.
        open.mockReturnValueOnce(null);
        await act(async () => {
            await expect(hook.getCurrent().startDownload({ path: 'spec.pdf', asZip: false, action: 'open' })).resolves.toEqual({ ok: true });
        });
        const buttons = alert.mock.calls.at(-1)![2]!;
        act(() => { buttons.at(-1)!.onPress!(); });
        expect(open).toHaveBeenCalledTimes(3);
        expect(alert).toHaveBeenCalledTimes(1);

        // Script-capable HTML never becomes a Happier-origin tab, even when asked to open.
        const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        await act(async () => {
            await expect(hook.getCurrent().startDownload({ path: 'index.html', asZip: false, action: 'open' })).resolves.toEqual({ ok: true });
        });
        expect(open).toHaveBeenCalledTimes(3);
        expect(click).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalled(), { timeout: 2_000 });
    });

    it('streams into OPFS and delays disk-backed URL cleanup until after the download is triggered', async () => {
        const diskFile = new File([new Uint8Array([1, 2, 3, 4])], 'report.txt');
        const write = vi.fn(async (_bytes: Uint8Array) => {});
        const close = vi.fn(async () => {});
        const abort = vi.fn(async () => {});
        const removeEntry = vi.fn(async () => {});
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-download');
        const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const click = vi.spyOn(browser.window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
            // Only post-click disk/URL cleanup is clock-controlled. Keep the
            // preceding real batch acquisition outside that frozen interval.
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        });
        const remove = vi.spyOn(browser.window.HTMLAnchorElement.prototype, 'remove');
        const appendChild = vi.spyOn(browser.document.body, 'appendChild');
        Object.defineProperty(browser.window.navigator, 'storage', {
            configurable: true,
            value: {
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
        const hook = await renderTransfers();

        await act(async () => {
            await expect(hook.getCurrent().startDownload({ path: 'report.txt', asZip: false })).resolves.toEqual({ ok: true });
        });

        expect(harness.rpcRequests).toContainEqual(expect.objectContaining({
            machineId: harness.scope.machineId,
            method: 'daemon.filesystem.download',
            payload: expect.objectContaining({ input: expect.objectContaining({ rootPath: '/repo', path: '/repo/report.txt', asZip: false }) }),
        }));
        expect(appendChild).toHaveBeenCalledTimes(1);
        expect(click).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledExactlyOnceWith(new Uint8Array([1, 2, 3, 4]));
        expect(close).toHaveBeenCalledTimes(1);
        expect(createObjectURL).toHaveBeenCalledWith(diskFile);
        expect(remove).not.toHaveBeenCalled();
        expect(removeEntry).not.toHaveBeenCalled();
        expect(revokeObjectURL).not.toHaveBeenCalled();

        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

        expect(remove).toHaveBeenCalledTimes(1);
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-download');
        expect(removeEntry).toHaveBeenCalledTimes(1);
        expect(abort).not.toHaveBeenCalled();
    });

    it('rejects a prepared file above the configured web maximum before publishing any bytes', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_FILES_DOWNLOAD_MAX_BYTES', '3');
        const createObjectURL = vi.spyOn(URL, 'createObjectURL');
        const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL');
        const click = vi.spyOn(browser.window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const hook = await renderTransfers();

        await act(async () => {
            await expect(hook.getCurrent().startDownload({ path: 'report.txt', asZip: false })).resolves.toEqual({
                ok: false, error: 'File exceeds the web download size limit',
            });
        });

        expect(hook.getCurrent().downloadState).toEqual({ status: 'error', error: 'File exceeds the web download size limit' });
        expect(harness.rpcRequests.some(request => request.method === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK)).toBe(false);
        expect(click).not.toHaveBeenCalled();
        expect(createObjectURL).not.toHaveBeenCalled();
        expect(revokeObjectURL).not.toHaveBeenCalled();
    });

    it('rejects a peer that sends more bytes than its prepared metadata without publishing the file', async () => {
        await harness.reset();
        harness = await createWorkspaceFileDownloadHarness({
            name: 'report.txt', bytes: new Uint8Array([1, 2, 3, 4]), advertisedDownloadSizeBytes: 1,
        });
        const createObjectURL = vi.spyOn(URL, 'createObjectURL');
        const click = vi.spyOn(browser.window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const hook = await renderTransfers();

        await act(async () => {
            await expect(hook.getCurrent().startDownload({ path: 'report.txt', asZip: false })).resolves.toEqual({
                ok: false, error: 'Downloaded size exceeded expected size',
            });
        });

        expect(hook.getCurrent().downloadState).toEqual({ status: 'error', error: 'Downloaded size exceeded expected size' });
        expect(createObjectURL).not.toHaveBeenCalled();
        expect(click).not.toHaveBeenCalled();
    });

    it('does not publish a browser download when unmounted while OPFS materializes the completed file', async () => {
        const fileRequested = createDeferred<void>();
        const materializedFile = createDeferred<File>();
        const diskFile = new File([new Uint8Array([1, 2, 3, 4])], 'report.txt');
        const getFile = vi.fn(async () => {
            fileRequested.resolve();
            return await materializedFile.promise;
        });
        const removeEntry = vi.fn(async () => {});
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:late-download');
        const click = vi.spyOn(browser.window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const appendChild = vi.spyOn(browser.document.body, 'appendChild');
        Object.defineProperty(browser.window.navigator, 'storage', {
            configurable: true,
            value: {
                getDirectory: async () => ({
                    getFileHandle: async () => ({
                        createWritable: async () => ({ write: async () => {}, close: async () => {}, abort: async () => {} }),
                        getFile,
                    }),
                    removeEntry,
                }),
            },
        });
        const hook = await renderTransfers();
        let pending!: ReturnType<ReturnType<typeof useWorkspaceFileTransfers>['startDownload']>;
        await act(async () => {
            pending = hook.getCurrent().startDownload({ path: 'report.txt', asZip: false });
            await fileRequested.promise;
        });
        expect(getFile).toHaveBeenCalledTimes(1);
        expect(harness.rpcRequests.some(request => request.method === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE)).toBe(true);

        await hook.unmount();
        await act(async () => {
            materializedFile.resolve(diskFile);
            await expect(pending).resolves.toEqual({ ok: false, error: 'Download canceled', canceled: true });
        });

        expect(removeEntry).toHaveBeenCalledTimes(1);
        expect(createObjectURL).not.toHaveBeenCalled();
        expect(appendChild).not.toHaveBeenCalled();
        expect(click).not.toHaveBeenCalled();
    });

    it('aborts an in-flight download on true unmount and ignores its late completion', async () => {
        const chunk = harness.deferNextChunk();
        const createObjectURL = vi.spyOn(URL, 'createObjectURL');
        const click = vi.spyOn(browser.window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const hook = await renderTransfers();
        let pending!: ReturnType<ReturnType<typeof useWorkspaceFileTransfers>['startDownload']>;
        await act(async () => {
            pending = hook.getCurrent().startDownload({ path: 'report.txt', asZip: false });
            await chunk.entered;
        });

        await hook.unmount();
        await expect(pending).resolves.toEqual({ ok: false, error: 'Download canceled', canceled: true });
        await act(async () => { chunk.release(); await chunk.settled; });

        expect(createObjectURL).not.toHaveBeenCalled();
        expect(click).not.toHaveBeenCalled();
    });
});
