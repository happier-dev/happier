import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const startUploadsSpy = vi.fn(async (..._args: any[]) => ({ ok: true } as const));
const readWebDroppedEntriesSpy = vi.fn(async (..._args: any[]) => [{ file: { name: 'a.txt', size: 1 }, relativePath: 'a.txt' }]);

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

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        storage: { getState: () => ({ setWorkspaceRepositoryTreeExpandedPaths: vi.fn() }) } as any,
        useWorkspaceRepositoryTreeExpandedPaths: () => [],
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
        snapshot: null,
        loading: false,
        error: null,
        refresh: vi.fn(async () => {}),
    }),
}));

vi.mock('@/hooks/ui/useWebFileDropZone', () => ({
    useWebFileDropZone: (params: any) => ({
        onDragEnter: (event: any) => {
            params.onFileDragActiveChange?.(true);
            if (Array.isArray(event?.dataTransfer?.types) && event.dataTransfer.types.includes('Files')) {
                // noop
            }
        },
        onDragLeave: () => params.onFileDragActiveChange?.(false),
        onDragOver: () => {},
        onDrop: (event: any) => {
            params.onFileDragActiveChange?.(false);
            void params.onFilesDropped(event);
        },
    }),
}));

vi.mock('@/utils/files/webDroppedEntries', () => ({
    readWebDroppedEntries: (...args: any[]) => readWebDroppedEntriesSpy(...args),
}));

vi.mock('@/hooks/workspaces/transfers/useWorkspaceFileTransfers', () => ({
    useWorkspaceFileTransfers: () => ({
        uploadState: { status: 'idle' },
        downloadState: { status: 'idle' },
        startUploads: (...args: any[]) => startUploadsSpy(...args),
        cancelUploads: vi.fn(),
        startDownload: vi.fn(async () => ({ ok: true })),
        cancelDownload: vi.fn(),
    }),
}));

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

vi.mock('@/components/workspaces/files/repositoryTree/ChangedFilesTreeList', () => ({
    ChangedFilesTreeList: () => React.createElement('ChangedFilesTreeList'),
}));

describe('WorkspaceRepositoryTreeBrowserView (drag overlay)', () => {
    beforeEach(() => {
        startUploadsSpy.mockClear();
        readWebDroppedEntriesSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    async function renderBrowser() {
        const { WorkspaceRepositoryTreeBrowserView } = await import('./WorkspaceRepositoryTreeBrowserView');
        return renderScreen(
            <WorkspaceRepositoryTreeBrowserView
                scope={{ serverId: 'server', machineId: 'm1', rootPath: '/repo' }}
                onOpenFile={vi.fn()}
            />,
        );
    }

    it('surfaces the hovered upload destination in the drop overlay', async () => {
        const screen = await renderBrowser();

        const repositoryTree = screen.findByTestId('workspace-repository-tree-list');
        expect(repositoryTree).toBeTruthy();
        await act(async () => {
            repositoryTree?.props.onWebDropTargetChange?.({
                destinationDir: 'src/components',
                hoverPath: 'src/components',
                autoExpandDirectoryPath: null,
            });
        });

        const overlay = screen.findByTestId('repository-tree-drop-overlay');
        expect(overlay?.props.destinationLabel).toBe('src/components');
    });

    it('shows drop overlay and starts workspace uploads when files are dropped', async () => {
        const screen = await renderBrowser();

        const dropZone = screen.findByTestId('repository-tree-drop-zone');
        expect(dropZone).toBeTruthy();

        await act(async () => {
            dropZone?.props.onDragEnter({ dataTransfer: { types: ['Files'] } });
        });

        const overlay = screen.findByTestId('repository-tree-drop-overlay');
        expect(overlay?.props.visible).toBe(true);

        await act(async () => {
            dropZone?.props.onDrop({ preventDefault: () => {}, dataTransfer: { types: ['Files'] } });
        });
        await flushHookEffects();

        expect(readWebDroppedEntriesSpy).toHaveBeenCalledTimes(1);
        expect(startUploadsSpy).toHaveBeenCalledWith({
            entries: [{ kind: 'web', file: { name: 'a.txt', size: 1 }, relativePath: 'a.txt' }],
            destinationDir: '',
        });
    });
});
