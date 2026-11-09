import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeTestInstanceHandler, standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from './sessionFilesViewTestkit';
import { createSessionFileNativeTransferBoundary } from '../sessionFileNativeTransferTestkit';
import { createExpoFileSystemFileMock } from '@/dev/testkit/mocks/expoFileSystem';

const nativeShare = vi.hoisted(() => ({ share: vi.fn(), sharedAction: 'sharedAction', dismissedAction: 'dismissedAction' }));
installSessionFilesViewBoundaries({ confirmResult: true, reactNativeOverrides: { Share: nativeShare } });
const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn() }));
vi.mock('expo-clipboard', () => clipboard);
await prepareSessionFilesViewTestkit();
const { WorkspaceFileDetailsView } = await import('@/components/workspaces/files/details/WorkspaceFileDetailsView');
const { FilePageHeader } = await import('@/components/workspaces/files/file/FilePageHeader');
const { FileContentPanel } = await import('@/components/workspaces/files/file/FileContentPanel');
const { FileViewerBody } = await import('@/components/workspaces/files/file/FileViewerBody');
const { FileTooLargeState } = await import('@/components/workspaces/files/file/FilePageStates');
const { FloatingOverlay } = await import('@/components/ui/overlays/FloatingOverlay');

let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let transfer: ReturnType<typeof createSessionFileNativeTransferBoundary>;
let previewSize = 0;
let shareAvailable = true;
const sharedBytes: number[][] = [];
let fileSystem: ReturnType<typeof createExpoFileSystemFileMock>;
const filePath = 'src/example.txt';
const fileText = 'first line\nsecond line – café\n';

beforeEach(async () => {
    standardCleanup();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        queueMicrotask(() => callback(0));
        return 0;
    });
    clipboard.setStringAsync.mockReset().mockResolvedValue(true);
    shareAvailable = true;
    sharedBytes.length = 0;
    fileSystem = createExpoFileSystemFileMock();
    nativeShare.share.mockReset().mockImplementation(async (content: { url: string }) => {
        sharedBytes.push([...fileSystem.files.get(content.url)!]);
        return { action: nativeShare.sharedAction };
    });
    // Native filesystem and share-sheet adapters only; transfers and byte delivery stay real.
    vi.doMock('expo-file-system', () => fileSystem.module);
    vi.doMock('expo-sharing', () => ({
        isAvailableAsync: async () => shareAvailable,
    }));
    const bytes = new TextEncoder().encode(fileText);
    previewSize = bytes.byteLength;
    transfer = createSessionFileNativeTransferBoundary({ bytes, name: 'example.txt' });
    fixture = await createSessionFilesViewFixture({
        serverIdentityId: 'srv_content_actions',
        machineCarrierOrigin: transfer.origin,
        request: transfer.request,
        rpc: request => request.method === 'statFile'
            ? { success: true, exists: true, kind: 'file', sizeBytes: previewSize }
            : request.method === 'scm.diff.file' ? { success: true, diff: '' } : transfer.rpc(request),
    });
    fixture.setSnapshot(fileViewSnapshot());
});
afterEach(async () => { standardCleanup(); await fixture?.dispose(); vi.unstubAllGlobals(); });

async function renderFile(path = filePath) {
    const screen = await fixture.render(<WorkspaceFileDetailsView scopeId="project:content-actions" scope={fixture.scope} filePath={path} presentation="screen" />);
    await vi.waitFor(() => expect(screen.findByTestId('file-action-toolbar')).not.toBeNull());
    await vi.waitFor(() => expect([
        ...screen.findAllByType(FileContentPanel), ...screen.findAllByType(FileViewerBody), ...screen.findAllByType(FileTooLargeState),
    ]).toHaveLength(1));
    return screen;
}

async function setToolbarWidth(screen: Awaited<ReturnType<typeof renderFile>>, width: number) {
    await act(async () => { invokeTestInstanceHandler(screen.findByTestId('file-details-header.root'), 'onLayout', { nativeEvent: { layout: { width } } }); });
}

function menuItem(screen: Awaited<ReturnType<typeof renderFile>>, id: string) {
    const items: React.ComponentProps<typeof FilePageHeader>['menuActions'] = screen.findByType(FilePageHeader).props.menuActions;
    return items?.find(item => item.id === id);
}

async function selectMenuItem(screen: Awaited<ReturnType<typeof renderFile>>, id: string) {
    await screen.pressByTestIdAsync('file-details-header.menu.trigger');
    if (!screen.findHostByTestId(`file-menu-${id}`)) {
        // The real menu virtualizes long text-file action lists. Scroll its
        // native viewport before selecting the Download row below the fold.
        const overlay = screen.findByType(FloatingOverlay);
        const scroller = overlay.findAll(node => typeof node.type === 'string' && typeof node.props.onScroll === 'function')[0]!;
        await act(async () => invokeTestInstanceHandler(scroller, 'onScroll', {
            nativeEvent: { contentOffset: { y: overlay.props.maxHeight * 2 },
                layoutMeasurement: { height: overlay.props.maxHeight } },
        }));
    }
    await vi.waitFor(() => expect(screen.findHostByTestId(`file-menu-${id}`)).not.toBeNull());
    await screen.pressByTestIdAsync(`file-menu-${id}`);
    await vi.waitFor(() => expect(screen.findHostByTestId(`file-menu-${id}`)).toBeNull());
}

describe('shared file reader content actions', () => {
    it('copies the whole current file and downloads its actual raw bytes from the wide page menu', async () => {
        const screen = await renderFile();
        await setToolbarWidth(screen, 900);
        await selectMenuItem(screen, 'copyContents');
        await vi.waitFor(() => expect(clipboard.setStringAsync).toHaveBeenCalledWith(fileText));
        await selectMenuItem(screen, 'download');
        await vi.waitFor(() => expect(sharedBytes).toEqual([Array.from(new TextEncoder().encode(fileText))]));
        expect(transfer.httpRequests.some(request => request.url.endsWith('/complete'))).toBe(true);
    });

    it('keeps whole-file copy and download reachable through the narrow accessible menu', async () => {
        const screen = await renderFile();
        await setToolbarWidth(screen, 390);
        expect(screen.findHostByTestId('file-details-copy-content')).toBeNull();
        const menu = screen.findHostByTestId('file-details-header.menu.trigger');
        expect(menu?.props.accessibilityLabel).toBeTruthy();
        await selectMenuItem(screen, 'copyContents');
        await vi.waitFor(() => expect(clipboard.setStringAsync).toHaveBeenCalledWith(fileText));
        await selectMenuItem(screen, 'download');
        await vi.waitFor(() => expect(sharedBytes).toEqual([Array.from(new TextEncoder().encode(fileText))]));
    });

    it('copies an empty text file without treating it as unavailable content', async () => {
        transfer.setPayload(new Uint8Array(0), 'empty.txt');
        previewSize = 0;
        const screen = await renderFile('empty.txt');
        await setToolbarWidth(screen, 900);
        expect(menuItem(screen, 'copyContents')).toBeDefined();
        expect(menuItem(screen, 'copyContents')?.disabled).not.toBe(true);
        await selectMenuItem(screen, 'copyContents');
        await vi.waitFor(() => expect(clipboard.setStringAsync).toHaveBeenCalledWith(''));
    });

    it('exports binary bytes without offering text copy', async () => {
        const bytes = new Uint8Array([0, 255, 1, 0, 128]);
        transfer.setPayload(bytes, 'opaque.bin');
        previewSize = bytes.byteLength;
        const screen = await renderFile('opaque.bin');
        await setToolbarWidth(screen, 900);
        expect(menuItem(screen, 'copyContents')).toBeUndefined();
        await selectMenuItem(screen, 'download');
        await vi.waitFor(() => expect(sharedBytes).toEqual([Array.from(bytes)]));
        expect(clipboard.setStringAsync).not.toHaveBeenCalled();
    });

    it('omits text copy when preview content is unavailable but retains raw download', async () => {
        previewSize = Number.MAX_SAFE_INTEGER;
        const screen = await renderFile();
        await setToolbarWidth(screen, 900);
        expect(menuItem(screen, 'copyContents')).toBeUndefined();
        await selectMenuItem(screen, 'download');
        await vi.waitFor(() => expect(sharedBytes).toEqual([Array.from(new TextEncoder().encode(fileText))]));
        expect(clipboard.setStringAsync).not.toHaveBeenCalled();
    });

    it('reports unavailable clipboard and raw destinations without claiming success', async () => {
        const { Modal } = await import('@/modal');
        clipboard.setStringAsync.mockResolvedValue(false);
        shareAvailable = false;
        const screen = await renderFile();
        await setToolbarWidth(screen, 900);
        await selectMenuItem(screen, 'copyContents');
        await vi.waitFor(() => expect(vi.mocked(Modal.alert)).toHaveBeenCalled());
        vi.mocked(Modal.alert).mockClear();
        await selectMenuItem(screen, 'download');
        await vi.waitFor(() => expect(vi.mocked(Modal.alert)).toHaveBeenCalled());
        expect(sharedBytes).toEqual([]);
    });
});
