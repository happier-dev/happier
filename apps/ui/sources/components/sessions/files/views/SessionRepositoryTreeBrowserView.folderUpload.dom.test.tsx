/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const startUploadsSpy = vi.fn(async () => ({ ok: true }));

vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: { OS: 'web', select: (value: any) => value?.web ?? value?.default ?? null },
    };
});

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
                divider: '#ddd',
                text: '#000',
                textSecondary: '#666',
            },
        },
    }),
    StyleSheet: {
        create: (value: any) =>
            typeof value === 'function'
                ? value({
                    colors: {
                        surface: '#fff',
                        surfaceHigh: '#f5f5f5',
                        divider: '#ddd',
                        text: '#000',
                        textSecondary: '#666',
                    },
                })
                : value,
    },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/sessions/files/content/RepositoryTreeList', () => ({
    RepositoryTreeList: () => React.createElement('div'),
}));

vi.mock('@/components/sessions/files/content/ChangedFilesTreeList', () => ({
    ChangedFilesTreeList: () => React.createElement('div'),
}));

vi.mock('@/components/sessions/files/content/SearchResultsList', () => ({
    SearchResultsList: () => React.createElement('div'),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: ({ trigger }: any) => React.createElement(React.Fragment, null, trigger({ toggle: vi.fn() })),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props),
}));

vi.mock('@/components/sessions/files/repositoryTree/RepositoryTreeDropOverlay', () => ({
    RepositoryTreeDropOverlay: () => null,
}));

vi.mock('@/components/sessions/files/repositoryTree/RepositoryTreeTransferStatusBar', () => ({
    RepositoryTreeTransferStatusBar: () => null,
}));

vi.mock('@/components/sessions/files/repositoryTree/WebDropTargetView', () => ({
    WebDropTargetView: ({ children, ...props }: any) => React.createElement('div', props, children),
}));

vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
    useScrollEdgeFades: () => ({
        visibility: { top: false, bottom: false, left: false, right: false },
        onViewportLayout: vi.fn(),
        onContentSizeChange: vi.fn(),
        onScroll: vi.fn(),
    }),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({
    ScrollEdgeFades: () => null,
}));

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
    ScrollEdgeIndicators: () => null,
}));

vi.mock('@/hooks/ui/useWebFileDropZone', () => ({
    useWebFileDropZone: () => ({}),
}));

vi.mock('@/utils/files/webDroppedEntries', () => ({
    readWebDroppedEntries: vi.fn(async () => []),
}));

vi.mock('@/utils/files/nativePickFiles', () => ({
    nativePickFiles: vi.fn(async () => []),
}));

vi.mock('@/hooks/session/files/useWorkspaceFileTransfers', () => ({
    useWorkspaceFileTransfers: () => ({
        uploadState: { status: 'idle' },
        downloadState: { status: 'idle' },
        startUploads: startUploadsSpy,
        cancelUploads: vi.fn(),
        startDownload: vi.fn(async () => ({ ok: true })),
        cancelDownload: vi.fn(),
    }),
}));

vi.mock('@/components/sessions/files/repositoryTree/showUploadConflictResolutionDialog', () => ({
    showUploadConflictResolutionDialog: vi.fn(async () => 'keep_both'),
}));

vi.mock('@/sync/domains/input/suggestionFile', () => ({
    searchFiles: vi.fn(async () => []),
    fileSearchCache: { clearCache: vi.fn() },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: { getState: () => ({ setSessionRepositoryTreeExpandedPaths: vi.fn() }) },
    useSession: () => ({ active: true, metadata: { machineId: 'm1' } }),
    useSessionRepositoryTreeExpandedPaths: () => [],
    useSessionProjectScmSnapshot: () => null,
}));

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({
        machineReachable: true,
        machineOnline: true,
        machineRpcTargetAvailable: true,
    }),
}));

vi.mock('@/modal', () => ({
    Modal: { prompt: vi.fn(async () => null), alert: vi.fn() },
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

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: { invalidateFromUser: vi.fn() },
}));

describe('SessionRepositoryTreeBrowserView web folder upload input', () => {
    it('starts web uploads from the hidden file input change event', async () => {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        startUploadsSpy.mockClear();

        try {
            await act(async () => {
                root.render(
                    <SessionRepositoryTreeBrowserView
                        sessionId="s1"
                        searchQuery="initial"
                        onOpenFile={vi.fn()}
                    />,
                );
            });

            const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'));
            expect(inputs).toHaveLength(2);

            const fileInput = inputs[0]!;
            const file = new File(['uploaded from test'], 'upload-source.txt', { type: 'text/plain' });

            await act(async () => {
                Object.defineProperty(fileInput, 'files', {
                    configurable: true,
                    value: [file],
                });
                fileInput.dispatchEvent(new Event('change', { bubbles: true }));
            });

            expect(startUploadsSpy).toHaveBeenCalledWith({
                entries: [
                    {
                        kind: 'web',
                        file,
                        relativePath: 'upload-source.txt',
                    },
                ],
                destinationDir: '',
            });
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });

    it('keeps directory-selection attributes on the hidden folder input after rerenders', async () => {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        try {
            await act(async () => {
                root.render(
                    <SessionRepositoryTreeBrowserView
                        sessionId="s1"
                        searchQuery="initial"
                        onOpenFile={vi.fn()}
                    />,
                );
            });

            const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'));
            expect(inputs).toHaveLength(2);

            const folderInput = inputs[1]!;
            expect(folderInput.hasAttribute('webkitdirectory')).toBe(true);
            expect(folderInput.hasAttribute('directory')).toBe(true);
            expect(folderInput.multiple).toBe(true);

            await act(async () => {
                root.render(
                    <SessionRepositoryTreeBrowserView
                        sessionId="s1"
                        searchQuery="next"
                        onOpenFile={vi.fn()}
                    />,
                );
            });

            expect(folderInput.hasAttribute('webkitdirectory')).toBe(true);
            expect(folderInput.hasAttribute('directory')).toBe(true);
            expect(folderInput.multiple).toBe(true);
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });
});
