import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const clearCacheSpy = vi.fn();

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
    View: 'View',
    ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props),
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    Dimensions: { get: () => ({ width: 1200, height: 800, scale: 2, fontScale: 1 }) },
    useWindowDimensions: () => ({ width: 1200, height: 800 }),
    AppState: {
        addEventListener: () => ({ remove: () => {} }),
        currentState: 'active',
    },
}));

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

vi.mock('@/sync/domains/state/storage', () => ({
    storage: { getState: () => ({ setSessionRepositoryTreeExpandedPaths: vi.fn() }) },
    useSession: () => ({ active: true, metadata: { machineId: 'm1' } }),
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

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: { invalidateFromUser: () => {} },
}));

vi.mock('@/sync/domains/input/suggestionFile', () => ({
    fileSearchCache: { clearCache: (sessionId: string) => clearCacheSpy(sessionId) },
    searchFiles: vi.fn(async () => []),
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
        expect(mountCount.current).toBe(2);
        expect(reloadCount.current).toBe(3);
    });
});
