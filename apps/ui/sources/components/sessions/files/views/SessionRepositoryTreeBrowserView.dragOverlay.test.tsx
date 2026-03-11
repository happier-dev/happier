import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const startUploadsSpy = vi.fn(async (..._args: any[]) => ({ ok: true } as const));
const startDownloadSpy = vi.fn(async (..._args: any[]) => ({ ok: true } as const));

const readWebDroppedEntriesSpy = vi.fn(async (..._args: any[]) => [{ file: { name: 'a.txt', size: 1 }, relativePath: 'a.txt' }]);
let machineRpcTargetAvailable = true;
let SessionRepositoryTreeBrowserView: typeof import('./SessionRepositoryTreeBrowserView').SessionRepositoryTreeBrowserView;

vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: { ...stub.Platform, OS: 'web' },
    };
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

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
                divider: '#eee',
                text: '#000',
                textSecondary: '#666',
                textLink: '#08f',
            },
            dark: false,
        },
    }),
    StyleSheet: {
        create: (value: any) =>
            typeof value === 'function'
                ? value({
                    colors: {
                        surface: '#fff',
                        surfaceHigh: '#f5f5f5',
                        divider: '#eee',
                        text: '#000',
                        textSecondary: '#666',
                        textLink: '#08f',
                    },
                    dark: false,
                })
                : value,
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: { getState: () => ({ setSessionRepositoryTreeExpandedPaths: vi.fn() }) },
    useSession: () => ({ active: true, metadata: { machineId: 'm1' } }),
    useSessionRepositoryTreeExpandedPaths: () => [],
    useSessionProjectScmSnapshot: () => null,
}));

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({
        machineReachable: machineRpcTargetAvailable,
        machineOnline: machineRpcTargetAvailable,
        machineRpcTargetAvailable,
    }),
}));

vi.mock('@/sync/domains/input/suggestionFile', () => ({
    fileSearchCache: { clearCache: vi.fn() },
    searchFiles: vi.fn(async () => []),
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: { invalidateFromUser: () => {} },
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn(), prompt: vi.fn(async () => null), confirm: vi.fn(async () => false), show: vi.fn(() => 'm1') },
}));

vi.mock('@/sync/ops', () => ({
    sessionWriteFile: vi.fn(async () => ({ success: true })),
    sessionCreateDirectory: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/utils/path/isSafeWorkspaceRelativePath', () => ({
    isSafeWorkspaceRelativePath: () => true,
}));

vi.mock('@/components/sessions/files/repositoryTree/computeExpandedPathsForReveal', () => ({
    computeExpandedPathsForReveal: ({ expandedPaths }: any) => expandedPaths,
}));

vi.mock('@/components/sessions/files/content/RepositoryTreeList', () => ({
    RepositoryTreeList: (props: any) => React.createElement('RepositoryTreeList', props),
}));

vi.mock('@/components/sessions/files/content/ChangedFilesTreeList', () => ({
    ChangedFilesTreeList: () => React.createElement('ChangedFilesTreeList'),
}));

vi.mock('@/components/sessions/files/content/SearchResultsList', () => ({
    SearchResultsList: () => React.createElement('SearchResultsList'),
}));

vi.mock('@/hooks/session/files/useWorkspaceFileTransfers', () => ({
    useWorkspaceFileTransfers: () => ({
        uploadState: { status: 'idle' },
        downloadState: { status: 'idle' },
        startUploads: (...args: any[]) => startUploadsSpy(...args),
        cancelUploads: vi.fn(),
        startDownload: (...args: any[]) => startDownloadSpy(...args),
        cancelDownload: vi.fn(),
    }),
}));

vi.mock('@/utils/files/webDroppedEntries', () => ({
    readWebDroppedEntries: (...args: any[]) => readWebDroppedEntriesSpy(...args),
}));

vi.mock('@/components/sessions/files/repositoryTree/RepositoryTreeDropOverlay', () => ({
    RepositoryTreeDropOverlay: (props: any) => React.createElement('RepositoryTreeDropOverlay', props),
}));

describe('SessionRepositoryTreeBrowserView (drag overlay)', () => {
    beforeAll(async () => {
        ({ SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView'));
    }, 60_000);

    beforeEach(() => {
        machineRpcTargetAvailable = true;
        startUploadsSpy.mockClear();
        startDownloadSpy.mockClear();
        readWebDroppedEntriesSpy.mockClear();
    });

    it('surfaces the hovered upload destination in the drop overlay', async () => {
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={vi.fn()} />);
        });

        const repositoryTree = tree.root.findByType('RepositoryTreeList' as any);
        await act(async () => {
            repositoryTree.props.onWebDropTargetChange?.({
                destinationDir: 'src/components',
                hoverPath: 'src/components',
                autoExpandDirectoryPath: null,
            });
        });

        const overlay = tree.root.findByType('RepositoryTreeDropOverlay' as any);
        expect(overlay.props.destinationLabel).toBe('src/components');
    });

    it('shows drop overlay and starts uploads when files are dropped', async () => {
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={vi.fn()} />);
        });

        const dropZone = tree.root.findByProps({ testID: 'repository-tree-drop-zone' });

        await act(async () => {
            dropZone.props.onDragEnter({ dataTransfer: { types: ['Files'] } });
        });

        const overlay = tree.root.findByType('RepositoryTreeDropOverlay' as any);
        expect(overlay.props.visible).toBe(true);

        await act(async () => {
            dropZone.props.onDrop({ preventDefault: () => {}, dataTransfer: { types: ['Files'] } });
        });

        await act(async () => {
            await Promise.resolve();
        });

        expect(readWebDroppedEntriesSpy).toHaveBeenCalledTimes(1);
        expect(startUploadsSpy).toHaveBeenCalledWith({
            entries: [{ kind: 'web', file: { name: 'a.txt', size: 1 }, relativePath: 'a.txt' }],
            destinationDir: '',
        });
    });

    it('keeps the hovered row destination when root dragover originates from a tree row descendant', async () => {
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={vi.fn()} />);
        });

        const repositoryTree = tree.root.findByType('RepositoryTreeList' as any);
        await act(async () => {
            repositoryTree.props.onWebDropTargetChange?.({
                destinationDir: 'download-me',
                hoverPath: 'download-me',
                autoExpandDirectoryPath: 'download-me',
            });
        });

        const dropZone = tree.root.findByProps({ testID: 'repository-tree-drop-zone' });
        await act(async () => {
            dropZone.props.onDragOver({
                dataTransfer: { types: ['Files'] },
                preventDefault: vi.fn(),
                currentTarget: {},
                target: {
                    closest: (selector: string) => selector === '[data-testid^="repository-tree-row-"]' ? {} : null,
                },
            });
        });

        const overlay = tree.root.findByType('RepositoryTreeDropOverlay' as any);
        expect(overlay.props.destinationLabel).toBe('download-me');
    });
});
