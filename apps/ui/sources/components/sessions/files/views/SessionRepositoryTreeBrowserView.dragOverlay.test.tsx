// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { createRepositoryPickerInputHost, nativeDocumentPickerBoundary } from '@/components/workspaces/files/repositoryTree/repositoryUploadBrowserTestFixture';
import { invokeRepositoryUploadPick } from '@/components/workspaces/files/repositoryTree/repositoryUploadActionRuntime';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createSessionFilesViewFixture, prepareSessionFilesViewTestkit, type FileViewRpcRequest } from './sessionFilesViewTestkit';

const machineRpcSpy = vi.hoisted(() => vi.fn(async (params: FileViewRpcRequest) => {
    if (params.method === 'listDirectory') return { success: true, entries: [] };
    return { success: true, exists: false };
}));
let SessionRepositoryTreeBrowserView: typeof import('./SessionRepositoryTreeBrowserView').SessionRepositoryTreeBrowserView;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// On web, draft persistence reads IndexedDB; the canonical fixture stands in for that browser boundary.
vi.mock('@/sync/domains/state/browserRecordStorage', async () => (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());
vi.mock('@/text', async () => (await import('@/dev/testkit')).createTextModuleMock({ translate: key => key }));
vi.mock('@/modal', async () => (await import('@/dev/testkit')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit')).createExpoVectorIconsMock());
vi.mock('@/components/ui/popover', async importOriginal => (await import('@/dev/testkit')).createInlinePopoverModuleMock(importOriginal));

// Node does not apply Metro's platform suffix resolution; execute the real web owner.
vi.mock('@/hooks/ui/useWebFileDropZone', () => import('@/hooks/ui/useWebFileDropZone.web'));

vi.mock('@/utils/files/webDroppedEntries', () => import('@/utils/files/webDroppedEntries.web'));

describe('SessionRepositoryTreeBrowserView (drag overlay)', () => {
    let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
    let restorePortal = () => {};
    let restoreLocks = () => {};
    beforeAll(async () => {
        // jsdom has no Web Locks; Home profile writes take a browser lock on web.
        const { installWebLockManagerMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
        restoreLocks = installWebLockManagerMock().restore;
        await prepareSessionFilesViewTestkit();
        // Test renderer has no ReactDOM portal host; keep the native DOM SDK boundary inline.
        const { requireReactDOM } = await import('@/utils/web/reactDomCjs');
        const portalBoundary = vi.spyOn(requireReactDOM(), 'createPortal').mockImplementation((content: unknown) => content);
        restorePortal = () => portalBoundary.mockRestore();
        ({ SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView'));
    }, 60_000);
    afterAll(() => { restorePortal(); restoreLocks(); });

    beforeEach(async () => {
        vi.stubGlobal('SharedWorker', class SharedWorker {});
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: machineRpcSpy });
        machineRpcSpy.mockClear();
    });

    afterEach(async () => {
        standardCleanup();
        await fixture?.dispose();
        vi.unstubAllGlobals();
    });

    async function renderRepositoryTreeBrowserView(inputs?: HTMLInputElement[]) {
        const pickerInputs = inputs ?? [];
        const dropHost = document.createElement('div');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        screen = await fixture.render(<SessionRepositoryTreeBrowserView sessionId="s1" serverId={fixture.scope.serverId} onOpenFile={vi.fn()} />,
            { createNodeMock: element => {
                if (element.props.testID === 'repository-tree-drop-zone') return dropHost;
                const index = pickerInputs.length;
                return createRepositoryPickerInputHost(element, pickerInputs, () => screen?.findAllByType('input')[index]?.props.onChange);
            } });
        return Object.assign(screen, { dropHost });
    }

    function dispatchFileDrag(host: HTMLElement, type: 'dragenter' | 'dragover' | 'drop', target = host, files: File[] = []) {
        if (!host.contains(target)) host.appendChild(target);
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
        Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files } });
        target.dispatchEvent(event);
    }

    function transferRequests() {
        return machineRpcSpy.mock.calls.filter(([params]) => params.method === RPC_METHODS.STAT_FILE
            || params.method === RPC_METHODS.WRITE_FILE || params.method.startsWith('daemon.directTransfer.')
            || params.method.startsWith('daemon.bulkTransfer.'));
    }

    it('surfaces the hovered upload destination in the drop overlay', async () => {
        const screen = await renderRepositoryTreeBrowserView();

        const row = document.createElement('div');
        row.setAttribute('data-repository-drop-destination', 'src/components');
        row.setAttribute('data-repository-drop-hover', 'src/components');
        await act(async () => {
            dispatchFileDrag(screen.dropHost, 'dragenter', row);
        });

        const overlay = screen.findByTestId('repository-tree-drop-overlay');
        expect(overlay).toBeTruthy();
        expect(screen.findAllByType('Text').some(node => node.props.children === 'src/components')).toBe(true);
    });

    it('shows drop overlay and starts uploads when files are dropped', async () => {
        const screen = await renderRepositoryTreeBrowserView();

        const dropZone = screen.findByTestId('repository-tree-drop-zone');
        expect(dropZone).toBeTruthy();

        await act(async () => {
            dispatchFileDrag(screen.dropHost, 'dragenter');
        });

        const overlay = screen.findByTestId('repository-tree-drop-overlay');
        expect(overlay).toBeTruthy();

        const file = new File(['hello'], 'a.txt');
        const releaseRow = document.createElement('div');
        releaseRow.setAttribute('data-repository-drop-destination', 'src/release');
        await act(async () => dispatchFileDrag(screen.dropHost, 'drop', releaseRow, [file]));
        await flushHookEffects();

        expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            targetId: 'm1', method: RPC_METHODS.STAT_FILE, payload: { path: '/repo/src/release/a.txt' },
        }));
    });

    it('keeps the hovered row destination when root dragover originates from a tree row descendant', async () => {
        const screen = await renderRepositoryTreeBrowserView();

        const row = document.createElement('div');
        row.setAttribute('data-repository-drop-destination', 'download-me');
        row.setAttribute('data-repository-drop-hover', 'download-me');
        row.setAttribute('data-repository-drop-expand', 'download-me');
        const descendant = document.createElement('span');
        row.appendChild(descendant);
        await act(async () => {
            screen.dropHost.appendChild(row);
            dispatchFileDrag(screen.dropHost, 'dragover', descendant);
        });

        const overlay = screen.findByTestId('repository-tree-drop-overlay');
        expect(overlay).toBeTruthy();
        expect(screen.findAllByType('Text').some(node => node.props.children === 'download-me')).toBe(true);
    });

    it.each(['files', 'folder'] as const)('acquires an Action %s picker for the addressed session workspace', async kind => {
        const inputs: HTMLInputElement[] = [];
        await renderRepositoryTreeBrowserView(inputs);
        const input = inputs.find(candidate => candidate.hasAttribute('webkitdirectory') === (kind === 'folder'))!;
        const clicked = vi.fn();
        input.addEventListener('click', clicked);
        expect(await invokeRepositoryUploadPick({
            scope: { serverId: fixture.scope.serverId, accountId: 'alice' },
            workspace: fixture.scope,
            kind, destinationDir: 'requested/session-subdir',
        })).toEqual({ status: 'requested' });
        expect(clicked).toHaveBeenCalledTimes(1);
        expect(transferRequests()).toHaveLength(0);
        const file = new File(['hello'], 'a.txt');
        const relativePath = kind === 'folder' ? 'docs/a.txt' : 'a.txt';
        Object.defineProperty(file, 'webkitRelativePath', { value: kind === 'folder' ? relativePath : '' });
        Object.defineProperty(input, 'files', { value: [file] });
        await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
        await flushHookEffects();
        expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            targetId: 'm1', method: RPC_METHODS.STAT_FILE, payload: { path: `/repo/requested/session-subdir/${relativePath}` },
        }));
    });

    it.each(['account', 'home'] as const)('retires the Session Action picker after its %s changes', async changed => {
        const inputs: HTMLInputElement[] = [];
        await renderRepositoryTreeBrowserView(inputs);
        const input = inputs.find(candidate => !candidate.hasAttribute('webkitdirectory'))!;
        expect(await invokeRepositoryUploadPick({
            scope: { serverId: fixture.scope.serverId, accountId: 'alice' },
            workspace: fixture.scope,
            kind: 'files', destinationDir: 'requested/session-subdir',
        })).toEqual({ status: 'requested' });
        const { getStorage } = await import('@/sync/domains/state/storage');
        await act(async () => getStorage().setState({ profileScope: {
            serverId: changed === 'home' ? 'other-home' : fixture.scope.serverId, accountId: 'other-account',
        } }));
        if (changed === 'account') await act(async () => getStorage().setState({ profileScope: { serverId: fixture.scope.serverId, accountId: 'alice' } }));
        machineRpcSpy.mockClear();
        Object.defineProperty(input, 'files', { value: [new File(['hello'], 'a.txt')] });
        await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
        await flushHookEffects();
        expect(transferRequests()).toHaveLength(0);
    });

    it('retires the awaited native Session picker before transferring under another Account', async () => {
        const { Platform } = await import('react-native');
        Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
        let finishSelection!: (value: unknown) => void;
        nativeDocumentPickerBoundary.mockImplementationOnce(() => new Promise(resolve => { finishSelection = resolve; }));
        try {
            await renderRepositoryTreeBrowserView();
            const requested = invokeRepositoryUploadPick({
                scope: { serverId: fixture.scope.serverId, accountId: 'alice' },
                workspace: fixture.scope,
                kind: 'files', destinationDir: 'requested/session-subdir',
            });
            await vi.waitFor(() => expect(finishSelection).toBeTypeOf('function'));
            const { getStorage } = await import('@/sync/domains/state/storage');
            await act(async () => getStorage().setState({ profileScope: { serverId: fixture.scope.serverId, accountId: 'other-account' } }));
            await act(async () => {
                finishSelection({ canceled: false, assets: [{ uri: 'file:///selected/a.txt', name: 'a.txt', size: 5, mimeType: 'text/plain' }] });
                await expect(requested).resolves.toEqual({ status: 'cancelled' });
            });
            expect(transferRequests()).toHaveLength(0);
        } finally {
            Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        }
    });
});
