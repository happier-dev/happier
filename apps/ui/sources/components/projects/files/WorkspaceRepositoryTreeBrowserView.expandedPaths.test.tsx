import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const storageSpies = vi.hoisted(() => ({
    setWorkspaceRepositoryTreeExpandedPaths: vi.fn(),
}));

const listPropsRef = vi.hoisted(() => ({
    current: null as null | React.ComponentProps<typeof import('./WorkspaceRepositoryTreeList').WorkspaceRepositoryTreeList>,
}));

const workspaceScmControllerState = vi.hoisted(() => ({
    snapshot: {
        repo: { isRepo: true, rootPath: '/repo' },
        entries: [
            {
                path: 'src/index.ts',
                kind: 'modified',
                stats: {
                    includedAdded: 1,
                    pendingAdded: 0,
                    includedRemoved: 0,
                    pendingRemoved: 0,
                },
            },
        ],
    } as any,
    refresh: vi.fn(async () => {}),
}));

const startDownloadSpy = vi.hoisted(() =>
    vi.fn(async (_input: { path: string; asZip: boolean }) => ({ ok: true } as const)),
);

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
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

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        storage: {
            getState: () => ({
                setWorkspaceRepositoryTreeExpandedPaths: storageSpies.setWorkspaceRepositoryTreeExpandedPaths,
            }),
        } as any,
        useWorkspaceRepositoryTreeExpandedPaths: () => ['src'],
        useMachine: () => ({ id: 'm1', active: true, activeAt: Date.now() }) as any,
    });
});

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesSnapshotForServerId: () => ({
        status: 'ready',
        features: {
            features: {
                machines: {
                    enabled: true,
                    transfer: { enabled: true },
                },
            },
            capabilities: {},
        },
    }),
}));

vi.mock('@/hooks/workspaces/scm/useWorkspaceScmSnapshotController', () => ({
    useWorkspaceScmSnapshotController: () => ({
        snapshot: workspaceScmControllerState.snapshot,
        loading: false,
        error: null,
        refresh: workspaceScmControllerState.refresh,
    }),
}));

vi.mock('./WorkspaceRepositoryTreeList', () => ({
    WorkspaceRepositoryTreeList: (props: any) => {
        listPropsRef.current = props;
        return React.createElement('View', { testID: 'workspace-repository-tree-list-stub' });
    },
}));

vi.mock('@/hooks/workspaces/transfers/useWorkspaceFileTransfers', () => ({
    useWorkspaceFileTransfers: () => ({
        uploadState: { status: 'idle' },
        downloadState: { status: 'idle' },
        startUploads: vi.fn(async () => ({ ok: true })),
        cancelUploads: vi.fn(),
        startDownload: (input: { path: string; asZip: boolean }) => startDownloadSpy(input),
        cancelDownload: vi.fn(),
    }),
}));

describe('WorkspaceRepositoryTreeBrowserView (expanded paths)', () => {
    it('uses the workspace SCM snapshot controller when no scmSnapshot prop is provided', async () => {
        const { WorkspaceRepositoryTreeBrowserView } = await import('./WorkspaceRepositoryTreeBrowserView');

        await renderScreen(
            <WorkspaceRepositoryTreeBrowserView
                scope={{ serverId: 's1', machineId: 'm1', rootPath: '/repo' }}
                onOpenFile={() => {}}
                showSearchBar={false}
            />,
        );

        expect(listPropsRef.current?.scmSnapshot).toBe(workspaceScmControllerState.snapshot);
    });

    it('uses workspace-scoped expanded paths when uncontrolled and writes updates to storage', async () => {
        const { WorkspaceRepositoryTreeBrowserView } = await import('./WorkspaceRepositoryTreeBrowserView');

        const screen = await renderScreen(
            <WorkspaceRepositoryTreeBrowserView
                scope={{ serverId: 's1', machineId: 'm1', rootPath: '/repo' }}
                onOpenFile={() => {}}
                showSearchBar={false}
            />,
        );

        expect(screen.tree.findAll((n) => n.props?.testID === 'workspace-repository-tree-list-stub')).toHaveLength(1);
        expect(listPropsRef.current?.expandedPaths).toEqual(['src']);

        listPropsRef.current?.onExpandedPathsChange(['src', 'packages']);
        expect(storageSpies.setWorkspaceRepositoryTreeExpandedPaths).toHaveBeenCalledWith(
            { serverId: 's1', machineId: 'm1', rootPath: '/repo' },
            ['src', 'packages'],
        );
    });

    it('provides default workspace-scoped row actions that can trigger downloads', async () => {
        const { WorkspaceRepositoryTreeBrowserView } = await import('./WorkspaceRepositoryTreeBrowserView');

        await renderScreen(
            <WorkspaceRepositoryTreeBrowserView
                scope={{ serverId: 's1', machineId: 'm1', rootPath: '/repo' }}
                onOpenFile={() => {}}
                showSearchBar={false}
            />,
        );

        const rowActionsNode = listPropsRef.current?.renderRowActions?.({
            type: 'file',
            path: 'src/index.ts',
            name: 'index.ts',
            sizeBytes: 42,
            modifiedMs: 1,
            depth: 0,
            parentDirectoryPath: 'src',
        } as any);

        const rowActionsElement = React.isValidElement<{ path: string; onSelect: (itemId: string) => Promise<void> }>(rowActionsNode)
            ? rowActionsNode
            : null;
        expect(rowActionsElement).toBeTruthy();
        expect(rowActionsElement?.props.path).toBe('src/index.ts');

        await act(async () => {
            await rowActionsElement?.props.onSelect('repository-tree-menuitem-download');
        });

        expect(startDownloadSpy).toHaveBeenCalledWith({ path: 'src/index.ts', asZip: false });
    });
});
