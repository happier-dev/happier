import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const clearCacheSpy = vi.fn();
const clearRepositoryDirectoryCacheSpy = vi.fn();
let latestTransferOptions: any = null;

vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
    };
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

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
                divider: '#eee',
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
                        divider: '#eee',
                        text: '#000',
                        textSecondary: '#666',
                    },
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

vi.mock('@/sync/domains/state/storage', () => ({
    storage: { getState: () => ({ setSessionRepositoryTreeExpandedPaths: vi.fn() }) },
    useSession: () => ({ active: true, metadata: { machineId: 'm1' } }),
    useProjectForSession: () => ({ key: { machineId: 'm1', path: '/repo' } }),
    useAllMachines: () => [{ id: 'm1', active: true, activeAt: 1, metadata: { host: 'mbp', platform: 'darwin', happyCliVersion: '0', happyHomeDir: '/tmp/.h', homeDir: '/tmp' } }],
    useMachine: () => ({ id: 'm1' }),
    useSessionRepositoryTreeExpandedPaths: () => [],
    useSessionProjectScmSnapshot: () => null,
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
vi.mock('@/components/sessions/files/content/RepositoryTreeList', () => ({
    RepositoryTreeList: (props: any) => {
        React.useEffect(() => {
            mountCount.current += 1;
        }, []);
        React.useEffect(() => {
            reloadCount.current += 1;
        }, [props?.reloadToken]);
        return React.createElement('RepositoryTreeList');
    },
}));

vi.mock('@/components/sessions/files/content/ChangedFilesTreeList', () => ({
    ChangedFilesTreeList: () => React.createElement('ChangedFilesTreeList'),
}));

vi.mock('@/components/sessions/files/content/SearchResultsList', () => ({
    SearchResultsList: () => React.createElement('SearchResultsList'),
}));

vi.mock('@/modal', () => ({
    Modal: {
        prompt: vi.fn(async () => null),
        alert: vi.fn(),
    },
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
    it('moves lower-priority toolbar actions into overflow when the toolbar is narrow', async () => {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={vi.fn()} />);
        });

        const toolbar = tree!.root.findByProps({ testID: 'repository-tree-toolbar' });
        await act(async () => {
            toolbar.props.onLayout?.({ nativeEvent: { layout: { width: 320, height: 42, x: 0, y: 0 } } });
        });

        expect(tree!.root.findAll((node: any) => node.props?.testID === 'repository-tree-filter-changed')).toHaveLength(1);
        expect(tree!.root.findAll((node: any) => node.props?.testID === 'repository-tree-refresh')).toHaveLength(1);
        expect(tree!.root.findAll((node: any) => node.props?.testID === 'repository-tree-create-file')).toHaveLength(0);
        const overflowMenu = tree!.root.findByType('ItemRowActions' as any);
        expect(overflowMenu.props.overflowTriggerTestID).toBe('repository-tree-toolbar-overflow');
        expect(overflowMenu.props.actions.map((item: any) => item.id)).toEqual(
            expect.arrayContaining([
                'repository-tree-create-file',
                'repository-tree-create-folder',
                'repository-tree-collapse-all',
            ]),
        );
    });

    it('shows clear button when search is non-empty and refresh clears search cache + remounts tree', async () => {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        clearCacheSpy.mockClear();
        mountCount.current = 0;
        reloadCount.current = 0;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={vi.fn()} />);
        });

        expect(mountCount.current).toBe(1);

        const input = tree!.root.findByType('TextInput');
        await act(async () => {
            input.props.onChangeText('src');
        });

        const clear = tree!.root.findAll((node: any) => node.props?.testID === 'repository-tree-clear-search');
        expect(clear.length).toBeGreaterThanOrEqual(1);

        await act(async () => {
            clear[0]!.props.onPress();
        });

        expect(tree!.root.findByType('TextInput').props.value).toBe('');

        const refresh = tree!.root.findAll((node: any) => node.props?.testID === 'repository-tree-refresh');
        expect(refresh.length).toBeGreaterThanOrEqual(1);

        await act(async () => {
            refresh[0]!.props.onPress();
        });

        expect(clearCacheSpy).toHaveBeenCalledWith('s1');
        expect(clearRepositoryDirectoryCacheSpy).toHaveBeenCalledWith({ sessionId: 's1' });
        expect(mountCount.current).toBe(2);
        expect(reloadCount.current).toBe(3);
    });

    it('refreshes the repository tree when uploads succeed', async () => {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        clearCacheSpy.mockClear();
        clearRepositoryDirectoryCacheSpy.mockClear();
        latestTransferOptions = null;
        reloadCount.current = 0;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={vi.fn()} />);
        });

        expect(typeof latestTransferOptions?.onAfterUploadSuccess).toBe('function');

        await act(async () => {
            latestTransferOptions.onAfterUploadSuccess();
        });

        expect(clearCacheSpy).toHaveBeenCalledWith('s1');
        expect(clearRepositoryDirectoryCacheSpy).toHaveBeenCalledWith({ sessionId: 's1' });
        expect(tree!.root.findAllByType('RepositoryTreeList').length).toBe(1);
        expect(reloadCount.current).toBe(2);
    });
});
