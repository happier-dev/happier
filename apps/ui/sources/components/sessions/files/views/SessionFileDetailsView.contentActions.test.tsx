import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, invokeTestInstanceHandler, standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from './sessionFilesViewTestkit';
import { createSessionFileNativeTransferBoundary } from '../sessionFileNativeTransferTestkit';
import { createExpoFileSystemFileMock } from '@/dev/testkit/mocks/expoFileSystem';

installSessionFilesViewBoundaries();
const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn() }));
vi.mock('expo-clipboard', () => clipboard);

let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let transfer: ReturnType<typeof createSessionFileNativeTransferBoundary>;
let previewSize = 0;
let shareAvailable = true;
const sharedBytes: number[][] = [];
let fileSystem: ReturnType<typeof createExpoFileSystemFileMock>;
const filePath = 'src/example.txt';
const fileText = 'first line\nsecond line – café\n';

beforeAll(prepareSessionFilesViewTestkit);
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
    // Native filesystem and share-sheet adapters only; transfers and byte delivery stay real.
    vi.doMock('expo-file-system', () => fileSystem.module);
    vi.doMock('expo-sharing', () => ({
        isAvailableAsync: async () => shareAvailable,
        shareAsync: async (uri: string) => { sharedBytes.push([...fileSystem.files.get(uri)!]); },
    }));
    const bytes = new TextEncoder().encode(fileText);
    previewSize = bytes.byteLength;
    transfer = createSessionFileNativeTransferBoundary({ bytes, name: 'example.txt' });
    fixture = await createSessionFilesViewFixture({
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
    const { WorkspaceFileDetailsView } = await import('@/components/workspaces/files/details/WorkspaceFileDetailsView');
    return fixture.render(<WorkspaceFileDetailsView scopeId="project:content-actions" scope={fixture.scope} filePath={path} presentation="screen" />);
}

async function setToolbarWidth(screen: Awaited<ReturnType<typeof renderFile>>, width: number) {
    await act(async () => { invokeTestInstanceHandler(screen.findByTestId('file-action-toolbar'), 'onLayout', { nativeEvent: { layout: { width } } }); });
}

describe('shared file reader content actions', () => {
    it('copies the whole current file and exports its actual raw bytes from the wide toolbar', async () => {
        const screen = await renderFile();
        await setToolbarWidth(screen, 900);
        await screen.pressByTestIdAsync('file-details-copy-content');
        expect(clipboard.setStringAsync).toHaveBeenCalledWith(fileText);
        await screen.pressByTestIdAsync('file-details-raw');
        await vi.waitFor(() => expect(sharedBytes).toEqual([Array.from(new TextEncoder().encode(fileText))]));
        expect(transfer.httpRequests.some(request => request.url.endsWith('/complete'))).toBe(true);
    });

    it('keeps whole-file copy and raw export reachable through the narrow accessible menu', async () => {
        const screen = await renderFile();
        await setToolbarWidth(screen, 390);
        expect(screen.findHostByTestId('file-details-copy-content')).toBeNull();
        const menu = screen.findHostByTestId('file-details-header.menu.trigger');
        expect(menu?.props.accessibilityLabel).toBeTruthy();
        await screen.pressByTestIdAsync('file-details-header.menu.trigger');
        await flushHookEffects({ cycles: 4 });
        await screen.pressByTestIdAsync('file-details-copy-content');
        expect(clipboard.setStringAsync).toHaveBeenCalledWith(fileText);
        await screen.pressByTestIdAsync('file-details-header.menu.trigger');
        await flushHookEffects({ cycles: 4 });
        await screen.pressByTestIdAsync('file-details-raw');
        await vi.waitFor(() => expect(sharedBytes).toEqual([Array.from(new TextEncoder().encode(fileText))]));
    });

    it('copies an empty text file without treating it as unavailable content', async () => {
        transfer.setPayload(new Uint8Array(0), 'empty.txt');
        previewSize = 0;
        const screen = await renderFile('empty.txt');
        await setToolbarWidth(screen, 900);
        expect(screen.findHostByTestId('file-details-copy-content')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('file-details-copy-content');
        expect(clipboard.setStringAsync).toHaveBeenCalledWith('');
    });

    it('exports binary bytes without offering text copy', async () => {
        const bytes = new Uint8Array([0, 255, 1, 0, 128]);
        transfer.setPayload(bytes, 'opaque.bin');
        previewSize = bytes.byteLength;
        const screen = await renderFile('opaque.bin');
        await setToolbarWidth(screen, 900);
        expect(screen.findHostByTestId('file-details-copy-content')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('file-details-raw');
        await vi.waitFor(() => expect(sharedBytes).toEqual([Array.from(bytes)]));
        expect(clipboard.setStringAsync).not.toHaveBeenCalled();
    });

    it('disables text copy when preview content is unavailable but retains raw download', async () => {
        previewSize = Number.MAX_SAFE_INTEGER;
        const screen = await renderFile();
        await setToolbarWidth(screen, 900);
        expect(screen.findHostByTestId('file-details-copy-content')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('file-details-raw');
        await vi.waitFor(() => expect(sharedBytes).toEqual([Array.from(new TextEncoder().encode(fileText))]));
        expect(clipboard.setStringAsync).not.toHaveBeenCalled();
    });

    it('reports unavailable clipboard and raw destinations without claiming success', async () => {
        const { Modal } = await import('@/modal');
        clipboard.setStringAsync.mockResolvedValue(false);
        shareAvailable = false;
        const screen = await renderFile();
        await setToolbarWidth(screen, 900);
        await screen.pressByTestIdAsync('file-details-copy-content');
        await vi.waitFor(() => expect(vi.mocked(Modal.alert)).toHaveBeenCalled());
        vi.mocked(Modal.alert).mockClear();
        await screen.pressByTestIdAsync('file-details-raw');
        await vi.waitFor(() => expect(vi.mocked(Modal.alert)).toHaveBeenCalled());
        expect(sharedBytes).toEqual([]);
    });
});
