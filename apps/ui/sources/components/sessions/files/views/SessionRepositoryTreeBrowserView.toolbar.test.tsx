import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const clearCacheSpy = vi.fn();
const clearRepositoryDirectoryCacheSpy = vi.fn();
let latestTransferOptions: any = null;

installSessionFilesViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
        });
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            storage: { getState: () => ({ setSessionRepositoryTreeExpandedPaths: vi.fn() }) } as any,
            useSession: () => ({ active: true, metadata: { machineId: 'm1' } }) as any,
            useProjectForSession: () => ({ key: { machineId: 'm1', path: '/repo' } }) as any,
            useAllMachines: () => [{ id: 'm1', active: true, activeAt: 1, metadata: { host: 'mbp', platform: 'darwin', happyCliVersion: '0', happyHomeDir: '/tmp/.h', homeDir: '/tmp' } }] as any,
            useMachine: () => ({ id: 'm1' }) as any,
            useSessionRepositoryTreeExpandedPaths: () => [],
            useSessionProjectScmSnapshot: () => null,
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => {
        const trigger = typeof props.trigger === 'function'
            ? props.trigger({ toggle: vi.fn(), openMenu: vi.fn(), closeMenu: vi.fn(), open: Boolean(props.open), selectedItem: null })
            : props.trigger;
        return React.createElement('DropdownMenu', props, trigger);
    },
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/hooks/session/files/useWorkspaceFileTransfers', () => ({
    useWorkspaceFileTransfers: (input: any) => {
        latestTransferOptions = input;
        return {
        uploadState: { status: 'idle' },
        downloadState: { status: 'idle' },
        startUploads: vi.fn(async () => ({ ok: true })),
        cancelUploads: vi.fn(),
        startDownload: vi.fn(async () => ({ ok: true })),
        cancelDownload: vi.fn(),
        };
    },
}));

vi.mock('@/components/sessions/sourceControl/states', () => ({
    SourceControlSessionInactiveState: () => React.createElement('SourceControlSessionInactiveState'),
}));

vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
    resolveSessionMachineReachability: () => true,
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => true,
}));

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({
        machineReachable: true,
        machineOnline: true,
        machineRpcTargetAvailable: true,
    }),
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: { invalidateFromUser: () => {} },
}));

vi.mock('@/sync/domains/input/suggestionFile', () => ({
    fileSearchCache: { clearCache: (sessionId: string) => clearCacheSpy(sessionId) },
    searchFiles: vi.fn(async () => []),
}));

vi.mock('@/sync/domains/input/repositoryDirectory', () => ({
    clearCachedRepositoryDirectoryEntries: (input: { sessionId: string }) => clearRepositoryDirectoryCacheSpy(input),
}));

const mountCount = { current: 0 };
const reloadCount = { current: 0 };
const repositoryTreeRootLoading = { current: false };
const latestRepositoryTreeListProps = { current: null as any };
vi.mock('@/components/sessions/files/content/RepositoryTreeList', () => ({
    RepositoryTreeList: (props: any) => {
        latestRepositoryTreeListProps.current = props;
        React.useEffect(() => {
            mountCount.current += 1;
        }, []);
        React.useEffect(() => {
            reloadCount.current += 1;
        }, [props?.reloadToken]);
        React.useEffect(() => {
            props?.onRootLoadingChange?.(repositoryTreeRootLoading.current);
        }, [props]);
        return React.createElement('View', { testID: 'repository-tree-list' });
    },
}));

vi.mock('@/components/sessions/files/content/ChangedFilesTreeList', () => ({
    ChangedFilesTreeList: () => React.createElement('ChangedFilesTreeList'),
}));

vi.mock('@/components/sessions/files/views/repositoryTreeBrowser/RepositoryTreeChangedFilesPane', () => ({
    RepositoryTreeChangedFilesPane: () => React.createElement('RepositoryTreeChangedFilesPane'),
}));

vi.mock('@/components/sessions/files/content/SearchResultsList', () => ({
    SearchResultsList: () => React.createElement('SearchResultsList'),
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

describe('SessionRepositoryTreeBrowserView (toolbar)', () => {
    afterEach(() => {
        repositoryTreeRootLoading.current = false;
        latestRepositoryTreeListProps.current = null;
        standardCleanup();
    });

    async function renderRepositoryTreeBrowserView() {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        return renderScreen(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={vi.fn()} />);
    }

    it('moves lower-priority toolbar actions into overflow when the toolbar is narrow', async () => {
        const screen = await renderRepositoryTreeBrowserView();

        const toolbar = screen.findByTestId('repository-tree-toolbar');
        expect(toolbar).toBeTruthy();
        await act(async () => {
            toolbar?.props.onLayout?.({ nativeEvent: { layout: { width: 320, height: 42, x: 0, y: 0 } } });
        });

        expect(screen.findAllByTestId('repository-tree-create-file')).toHaveLength(0);
        const overflowMenu = screen.findByType('ItemRowActions' as any);
        expect(overflowMenu.props.overflowTriggerTestID).toBe('repository-tree-toolbar-overflow');
        const refreshInlineCount = screen.findAllByTestId('repository-tree-refresh').length;
        const refreshInOverflow = overflowMenu.props.actions.some((item: any) => item.id === 'repository-tree-refresh');
        expect(refreshInlineCount > 0 || refreshInOverflow).toBe(true);
        const filterInlineCount = screen.findAllByTestId('repository-tree-filter-changed').length;
        const filterInOverflow = overflowMenu.props.actions.some((item: any) => item.id === 'repository-tree-filter-changed');
        expect(filterInlineCount > 0 || filterInOverflow).toBe(true);
        expect(overflowMenu.props.actions.map((item: any) => item.id)).toEqual(
            expect.arrayContaining([
                'repository-tree-create-file',
                'repository-tree-create-folder',
            ]),
        );
    });

    it('keeps refresh visible and uses it as the tree refresh loading indicator', async () => {
        repositoryTreeRootLoading.current = true;
        const screen = await renderRepositoryTreeBrowserView();

        expect(latestRepositoryTreeListProps.current).toBeTruthy();
        expect(typeof latestRepositoryTreeListProps.current?.onRootLoadingChange).toBe('function');
        await act(async () => {
            latestRepositoryTreeListProps.current?.onRootLoadingChange?.(true);
        });

        const toolbar = screen.findByTestId('repository-tree-toolbar');
        expect(toolbar).toBeTruthy();
        await act(async () => {
            toolbar?.props.onLayout?.({ nativeEvent: { layout: { width: 320, height: 42, x: 0, y: 0 } } });
        });

        expect(screen.findAllByTestId('repository-tree-refresh').length).toBeGreaterThanOrEqual(1);
        const overflowMenu = screen.findByType('ItemRowActions' as any);
        expect(overflowMenu.props.actions.some((item: any) => item.id === 'repository-tree-refresh')).toBe(false);
        expect(screen.findByTestId('repository-tree-refresh-loading')).toBeTruthy();
    });

    it('hides collapse-all when no folders are expanded', async () => {
        const screen = await renderRepositoryTreeBrowserView();

        expect(screen.findAllByTestId('repository-tree-collapse-all')).toHaveLength(0);
        const overflowMenu = screen.findAllByType('ItemRowActions' as any)[0] ?? null;
        expect(overflowMenu?.props.actions.some((item: any) => item.id === 'repository-tree-collapse-all') ?? false).toBe(false);
    });

    it('shows clear button when search is non-empty and refresh clears search cache + remounts tree', async () => {
        clearCacheSpy.mockClear();
        mountCount.current = 0;
        reloadCount.current = 0;

        const screen = await renderRepositoryTreeBrowserView();

        expect(mountCount.current).toBe(1);

        const input = screen.findByTestId('repository-tree-search');
        expect(input).toBeTruthy();
        await act(async () => {
            input?.props.onChangeText('src');
        });

        const clear = screen.findAllByTestId('repository-tree-clear-search');
        expect(clear.length).toBeGreaterThanOrEqual(1);

        await act(async () => {
            screen.pressByTestId('repository-tree-clear-search');
        });

        expect(screen.findByTestId('repository-tree-search')?.props.value).toBe('');

        expect(screen.findAllByTestId('repository-tree-refresh').length).toBeGreaterThanOrEqual(1);

        await act(async () => {
            screen.pressByTestId('repository-tree-refresh');
        });

        expect(clearCacheSpy).toHaveBeenCalledWith('s1');
        expect(clearRepositoryDirectoryCacheSpy).toHaveBeenCalledWith({ sessionId: 's1' });
        expect(mountCount.current).toBe(2);
        expect(reloadCount.current).toBe(3);
    });

    it('refreshes the repository tree when uploads succeed', async () => {
        clearCacheSpy.mockClear();
        clearRepositoryDirectoryCacheSpy.mockClear();
        latestTransferOptions = null;
        reloadCount.current = 0;

        const screen = await renderRepositoryTreeBrowserView();

        expect(typeof latestTransferOptions?.onAfterUploadSuccess).toBe('function');

        await act(async () => {
            latestTransferOptions.onAfterUploadSuccess();
        });

        expect(clearCacheSpy).toHaveBeenCalledWith('s1');
        expect(clearRepositoryDirectoryCacheSpy).toHaveBeenCalledWith({ sessionId: 's1' });
        expect(screen.findAllByTestId('repository-tree-list')).toHaveLength(1);
        expect(reloadCount.current).toBe(2);
    });
});
