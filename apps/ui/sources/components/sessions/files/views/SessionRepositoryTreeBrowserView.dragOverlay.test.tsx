// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';
import { primeRepositoryUploadBrowserFixture, createRepositoryPickerInputHost, nativeDocumentPickerBoundary } from '@/components/workspaces/files/repositoryTree/repositoryUploadBrowserTestFixture';
import { invokeRepositoryUploadPick } from '@/components/workspaces/files/repositoryTree/repositoryUploadActionRuntime';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineRpcSpy = vi.hoisted(() => vi.fn(async (_params: unknown) => ({ success: true, exists: false })));

let machineRpcTargetAvailable = true;
let SessionRepositoryTreeBrowserView: typeof import('./SessionRepositoryTreeBrowserView').SessionRepositoryTreeBrowserView;

installSessionFilesViewCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        const modalModuleMock = createModalModuleMock();
        modalModuleMock.spies.show.mockImplementation(() => 'm1');
        return modalModuleMock.module;
    },
    storage: (importOriginal) => importOriginal(),
});

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props),
}));

// Node does not apply Metro's platform suffix resolution; execute the real web owner.
vi.mock('@/hooks/ui/useWebFileDropZone', () => import('@/hooks/ui/useWebFileDropZone.web'));

vi.mock('@/components/sessions/agents/presentation/useSessionMachineName', () => ({
    useSessionMachineName: () => 'MacBook Pro',
}));

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({
        machineReachable: machineRpcTargetAvailable,
        machineOnline: machineRpcTargetAvailable,
        machineRpcTargetAvailable,
    }),
}));

vi.mock('@/hooks/session/useSessionWorkspaceTarget', () => ({
    useSessionWorkspaceTarget: () => ({
        workspaceCacheKey: 'server:m1:/repo',
        machineId: 'm1',
        rootPath: '/repo',
        serverId: 'server',
    }),
}));

vi.mock('@/sync/domains/input/suggestionFile', () => ({
    fileSearchCache: { clearCache: vi.fn() },
    searchFiles: vi.fn(async () => []),
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: { invalidateFromUser: () => {} },
}));

vi.mock('@/sync/domains/session/resolveWorkspaceTargetForSession', () => ({
    resolveWorkspaceTargetForSession: () => ({
        workspaceCacheKey: 'server:m1:/repo',
        machineId: 'm1',
        rootPath: '/repo',
        serverId: 'server',
    }),
}));

vi.mock('@/sync/ops/workspaceFileSystem', () => ({
    workspaceWriteFile: vi.fn(async () => ({ success: true })),
    workspaceCreateDirectory: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/utils/path/isSafeWorkspaceRelativePath', () => ({
    isSafeWorkspaceRelativePath: () => true,
}));

vi.mock('@/components/workspaces/files/repositoryTree/computeExpandedPathsForReveal', () => ({
    computeExpandedPathsForReveal: ({ expandedPaths }: any) => expandedPaths,
}));

vi.mock('@/components/projects/files/WorkspaceRepositoryTreeList', () => ({
    WorkspaceRepositoryTreeList: (props: any) => React.createElement('View', { ...props, testID: 'repository-tree-list' }),
}));

vi.mock('@/components/workspaces/files/repositoryTree/WebDropTargetView', () => ({
    WebDropTargetView: (props: any) => React.createElement('View', props),
}));

vi.mock('@/components/workspaces/files/repositoryTree/SearchResultsList', () => ({
    SearchResultsList: () => React.createElement('SearchResultsList'),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    // Generic RPC responses are schema-owned by the real caller beneath this network boundary.
    return createServerScopedMachineRpcBoundaryMock(machineRpcSpy as typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope);
});

vi.mock('@/utils/files/webDroppedEntries', () => import('@/utils/files/webDroppedEntries.web'));

vi.mock('@/components/workspaces/files/repositoryTree/RepositoryTreeDropOverlay', () => ({
    RepositoryTreeDropOverlay: (props: any) => React.createElement('View', { ...props, testID: 'repository-tree-drop-overlay' }),
}));

describe('SessionRepositoryTreeBrowserView (drag overlay)', () => {
    beforeAll(async () => {
        ({ SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView'));
    }, 60_000);

    beforeEach(async () => {
        vi.stubGlobal('SharedWorker', class SharedWorker {});
        await primeRepositoryUploadBrowserFixture();
        machineRpcTargetAvailable = true;
        machineRpcSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
        vi.unstubAllGlobals();
    });

    async function renderRepositoryTreeBrowserView(inputs?: HTMLInputElement[]) {
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        screen = await renderScreen(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={vi.fn()} />,
            inputs ? { createNodeMock: element => {
                if (!React.isValidElement<Record<string, unknown>>(element)) return null;
                const index = inputs.length;
                return createRepositoryPickerInputHost(element, inputs, () => screen?.findAllByType('input')[index]?.props.onChange);
            } } : {});
        return screen;
    }

    it('surfaces the hovered upload destination in the drop overlay', async () => {
        const screen = await renderRepositoryTreeBrowserView();

        const dropZone = screen.findByTestId('repository-tree-drop-zone');
        const row = document.createElement('div');
        row.setAttribute('data-repository-drop-destination', 'src/components');
        row.setAttribute('data-repository-drop-hover', 'src/components');
        await act(async () => {
            dropZone?.props.onDragEnter?.({
                dataTransfer: { types: ['Files'] },
                target: row,
            });
        });

        const overlay = screen.findByTestId('repository-tree-drop-overlay');
        expect(overlay?.props.destinationLabel).toBe('src/components');
    });

    it('shows drop overlay and starts uploads when files are dropped', async () => {
        const screen = await renderRepositoryTreeBrowserView();

        const dropZone = screen.findByTestId('repository-tree-drop-zone');
        expect(dropZone).toBeTruthy();

        await act(async () => {
            dropZone?.props.onDragEnter({ dataTransfer: { types: ['Files'] } });
        });

        const overlay = screen.findByTestId('repository-tree-drop-overlay');
        expect(overlay?.props.visible).toBe(true);

        const file = new File(['hello'], 'a.txt');
        const releaseRow = document.createElement('div');
        releaseRow.setAttribute('data-repository-drop-destination', 'src/release');
        await act(async () => dropZone?.props.onDrop({
            preventDefault: () => {}, target: releaseRow, dataTransfer: { types: ['Files'], files: [file] },
        }));
        await flushHookEffects();

        expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'server', machineId: 'm1', method: RPC_METHODS.STAT_FILE, payload: { path: '/repo/src/release/a.txt' },
        }));
    });

    it('keeps the hovered row destination when root dragover originates from a tree row descendant', async () => {
        const screen = await renderRepositoryTreeBrowserView();

        const dropZone = screen.findByTestId('repository-tree-drop-zone');
        const row = document.createElement('div');
        row.setAttribute('data-repository-drop-destination', 'download-me');
        row.setAttribute('data-repository-drop-hover', 'download-me');
        row.setAttribute('data-repository-drop-expand', 'download-me');
        const descendant = document.createElement('span');
        row.appendChild(descendant);
        await act(async () => {
            dropZone?.props.onDragOver({
                dataTransfer: { types: ['Files'] },
                preventDefault: vi.fn(),
                target: descendant,
            });
        });

        const overlay = screen.findByTestId('repository-tree-drop-overlay');
        expect(overlay?.props.destinationLabel).toBe('download-me');
    });

    it.each(['files', 'folder'] as const)('acquires an Action %s picker for the addressed session workspace', async kind => {
        const inputs: HTMLInputElement[] = [];
        await renderRepositoryTreeBrowserView(inputs);
        const input = inputs.find(candidate => candidate.hasAttribute('webkitdirectory') === (kind === 'folder'))!;
        const clicked = vi.fn();
        input.addEventListener('click', clicked);
        expect(await invokeRepositoryUploadPick({
            scope: { serverId: 'server', accountId: 'account' },
            workspace: { serverId: 'server', machineId: 'm1', rootPath: '/repo' },
            kind, destinationDir: 'requested/session-subdir',
        })).toEqual({ status: 'requested' });
        expect(clicked).toHaveBeenCalledTimes(1);
        expect(machineRpcSpy).not.toHaveBeenCalled();
        const file = new File(['hello'], 'a.txt');
        const relativePath = kind === 'folder' ? 'docs/a.txt' : 'a.txt';
        Object.defineProperty(file, 'webkitRelativePath', { value: kind === 'folder' ? relativePath : '' });
        Object.defineProperty(input, 'files', { value: [file] });
        await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
        await flushHookEffects();
        expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'server', machineId: 'm1', method: RPC_METHODS.STAT_FILE, payload: { path: `/repo/requested/session-subdir/${relativePath}` },
        }));
    });

    it.each(['account', 'home'] as const)('retires the Session Action picker after its %s changes', async changed => {
        const inputs: HTMLInputElement[] = [];
        await renderRepositoryTreeBrowserView(inputs);
        const input = inputs.find(candidate => !candidate.hasAttribute('webkitdirectory'))!;
        expect(await invokeRepositoryUploadPick({
            scope: { serverId: 'server', accountId: 'account' },
            workspace: { serverId: 'server', machineId: 'm1', rootPath: '/repo' },
            kind: 'files', destinationDir: 'requested/session-subdir',
        })).toEqual({ status: 'requested' });
        const { getStorage } = await import('@/sync/domains/state/storage');
        await act(async () => getStorage().setState({ profileScope: {
            serverId: changed === 'home' ? 'other-home' : 'server', accountId: 'other-account',
        } }));
        if (changed === 'account') await act(async () => getStorage().setState({ profileScope: { serverId: 'server', accountId: 'account' } }));
        machineRpcSpy.mockClear();
        Object.defineProperty(input, 'files', { value: [new File(['hello'], 'a.txt')] });
        await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
        await flushHookEffects();
        expect(machineRpcSpy).not.toHaveBeenCalled();
    });

    it('retires the awaited native Session picker before transferring under another Account', async () => {
        const { Platform } = await import('react-native');
        Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
        let finishSelection!: (value: unknown) => void;
        nativeDocumentPickerBoundary.mockImplementationOnce(() => new Promise(resolve => { finishSelection = resolve; }));
        try {
            await renderRepositoryTreeBrowserView();
            const requested = invokeRepositoryUploadPick({
                scope: { serverId: 'server', accountId: 'account' },
                workspace: { serverId: 'server', machineId: 'm1', rootPath: '/repo' },
                kind: 'files', destinationDir: 'requested/session-subdir',
            });
            await vi.waitFor(() => expect(finishSelection).toBeTypeOf('function'));
            const { getStorage } = await import('@/sync/domains/state/storage');
            await act(async () => getStorage().setState({ profileScope: { serverId: 'server', accountId: 'other-account' } }));
            await act(async () => {
                finishSelection({ canceled: false, assets: [{ uri: 'file:///selected/a.txt', name: 'a.txt', size: 5, mimeType: 'text/plain' }] });
                await expect(requested).resolves.toEqual({ status: 'cancelled' });
            });
            expect(machineRpcSpy).not.toHaveBeenCalled();
        } finally {
            Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        }
    });
});
