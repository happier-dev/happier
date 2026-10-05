// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { primeRepositoryUploadBrowserFixture, createRepositoryPickerInputHost, nativeDocumentPickerBoundary } from '@/components/workspaces/files/repositoryTree/repositoryUploadBrowserTestFixture';
import { invokeRepositoryUploadPick } from '@/components/workspaces/files/repositoryTree/repositoryUploadActionRuntime';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineRpcSpy = vi.hoisted(() => vi.fn(async (_params: unknown) => ({ success: true, exists: false })));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
        View: (props: any) => React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/hooks/workspaces/scm/useWorkspaceScmSnapshotController', () => ({
    useWorkspaceScmSnapshotController: () => ({
        snapshot: null,
        loading: false,
        error: null,
        refresh: vi.fn(async () => {}),
    }),
}));

// Node does not apply Metro's platform suffix resolution; execute the real web owner.
vi.mock('@/hooks/ui/useWebFileDropZone', () => import('@/hooks/ui/useWebFileDropZone.web'));

vi.mock('@/utils/files/webDroppedEntries', () => import('@/utils/files/webDroppedEntries.web'));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    // Generic RPC responses are schema-owned by the real caller beneath this network boundary.
    return createServerScopedMachineRpcBoundaryMock(machineRpcSpy as typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope);
});

vi.mock('@/components/projects/files/WorkspaceRepositoryTreeList', () => ({
    WorkspaceRepositoryTreeList: (props: any) => React.createElement('View', { ...props, testID: 'workspace-repository-tree-list' }),
}));

vi.mock('@/components/workspaces/files/repositoryTree/WebDropTargetView', () => ({
    WebDropTargetView: (props: any) => React.createElement('View', props),
}));

vi.mock('@/components/workspaces/files/repositoryTree/RepositoryTreeDropOverlay', () => ({
    RepositoryTreeDropOverlay: (props: any) => React.createElement('View', { ...props, testID: 'repository-tree-drop-overlay' }),
}));

vi.mock('@/components/workspaces/files/repositoryTree/SearchResultsList', () => ({
    SearchResultsList: () => React.createElement('SearchResultsList'),
}));

describe('WorkspaceRepositoryTreeBrowserView (drag overlay)', () => {
    beforeEach(async () => {
        // Browser feature detection is an external platform boundary.
        vi.stubGlobal('SharedWorker', class SharedWorker {});
        await primeRepositoryUploadBrowserFixture();
        machineRpcSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
        vi.unstubAllGlobals();
    });

    async function renderBrowser(inputs?: HTMLInputElement[]) {
        const { WorkspaceRepositoryTreeBrowserView } = await import('./WorkspaceRepositoryTreeBrowserView');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        screen = await renderScreen(
            <WorkspaceRepositoryTreeBrowserView
                scope={{ serverId: 'server', machineId: 'm1', rootPath: '/repo' }}
                onOpenFile={vi.fn()}
            />,
            inputs ? { createNodeMock: element => {
                if (!React.isValidElement<Record<string, unknown>>(element)) return null;
                const index = inputs.length;
                return createRepositoryPickerInputHost(element, inputs, () => screen?.findAllByType('input')[index]?.props.onChange);
            } } : {},
        );
        return screen;
    }

    it('surfaces the hovered upload destination in the drop overlay', async () => {
        const screen = await renderBrowser();

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

    it('shows drop feedback and dispatches files to the row at release rather than an earlier hover', async () => {
        const screen = await renderBrowser();

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

    it.each(['files', 'folder'] as const)('acquires an Action %s picker and preserves its exact requested destination', async kind => {
        const inputs: HTMLInputElement[] = [];
        await renderBrowser(inputs);
        const input = inputs.find(candidate => candidate.hasAttribute('webkitdirectory') === (kind === 'folder'))!;
        expect(input).toBeTruthy();
        const clicked = vi.fn();
        input.addEventListener('click', clicked);
        expect(await invokeRepositoryUploadPick({
            scope: { serverId: 'server', accountId: 'account' },
            workspace: { serverId: 'server', machineId: 'm1', rootPath: '/repo' },
            kind, destinationDir: 'requested/subdir',
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
            serverId: 'server', machineId: 'm1', method: RPC_METHODS.STAT_FILE, payload: { path: `/repo/requested/subdir/${relativePath}` },
        }));
    });

    it.each(['workspace', 'account', 'home'] as const)('retires an open Action picker after its %s changes', async changed => {
        const inputs: HTMLInputElement[] = [];
        const screen = await renderBrowser(inputs);
        const input = inputs.find(candidate => !candidate.hasAttribute('webkitdirectory'))!;
        expect(await invokeRepositoryUploadPick({
            scope: { serverId: 'server', accountId: 'account' },
            workspace: { serverId: 'server', machineId: 'm1', rootPath: '/repo' },
            kind: 'files', destinationDir: 'requested/subdir',
        })).toEqual({ status: 'requested' });
        if (changed === 'workspace') {
            const { WorkspaceRepositoryTreeBrowserView } = await import('./WorkspaceRepositoryTreeBrowserView');
            await screen.update(<WorkspaceRepositoryTreeBrowserView scope={{ serverId: 'server', machineId: 'm1', rootPath: '/other' }} onOpenFile={vi.fn()} />);
        } else {
            const { getStorage } = await import('@/sync/domains/state/storage');
            await act(async () => getStorage().setState({ profileScope: {
                serverId: changed === 'home' ? 'other-home' : 'server', accountId: 'other-account',
            } }));
            // Returning to the same Account must not revive the earlier OS selection.
            if (changed === 'account') await act(async () => getStorage().setState({ profileScope: { serverId: 'server', accountId: 'account' } }));
        }
        machineRpcSpy.mockClear();
        Object.defineProperty(input, 'files', { value: [new File(['hello'], 'a.txt')] });
        await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
        await flushHookEffects();
        expect(machineRpcSpy).not.toHaveBeenCalled();
    });

    it('retires a native picker awaiting OS selection before transferring under another Account', async () => {
        const { Platform } = await import('react-native');
        Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
        let finishSelection!: (value: unknown) => void;
        nativeDocumentPickerBoundary.mockImplementationOnce(() => new Promise(resolve => { finishSelection = resolve; }));
        try {
            await renderBrowser();
            const requested = invokeRepositoryUploadPick({
                scope: { serverId: 'server', accountId: 'account' },
                workspace: { serverId: 'server', machineId: 'm1', rootPath: '/repo' },
                kind: 'files', destinationDir: 'requested/subdir',
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
