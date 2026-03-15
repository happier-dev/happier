import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setExpandedPathsSpy = vi.fn();

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
    View: 'View',
    ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props),
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    Dimensions: { get: () => ({ width: 1200, height: 800, scale: 2, fontScale: 1 }) },
    useWindowDimensions: () => ({ width: 1200, height: 800 }),
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
                textLink: '#08f',
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
                        textLink: '#08f',
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
    storage: { getState: () => ({ setSessionRepositoryTreeExpandedPaths: setExpandedPathsSpy }) },
    useSession: () => ({ active: true, metadata: { machineId: 'm1' } }),
    useProjectForSession: () => ({ key: { machineId: 'm1', path: '/repo' } }),
    useAllMachines: () => [{ id: 'm1', active: true, activeAt: 1, metadata: { host: 'mbp', platform: 'darwin', happyCliVersion: '0', happyHomeDir: '/tmp/.h', homeDir: '/tmp' } }],
    useMachine: () => ({ id: 'm1' }),
    useSessionRepositoryTreeExpandedPaths: () => ['src'],
    useSessionProjectScmSnapshot: () => ({
        projectKey: 'p',
        fetchedAt: 1,
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
        capabilities: {} as any,
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false,
        entries: [],
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
    }),
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
    fileSearchCache: { clearCache: () => {} },
    searchFiles: vi.fn(async () => []),
}));

vi.mock('@/components/sessions/files/content/RepositoryTreeList', () => ({
    RepositoryTreeList: () => React.createElement('RepositoryTreeList'),
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

describe('SessionRepositoryTreeBrowserView (changed-only toggle)', () => {
    it('toggles between full repository tree and changed-only tree', async () => {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={vi.fn()} />);
        });

        expect(tree!.root.findAllByType('RepositoryTreeList' as any)).toHaveLength(1);
        expect(tree!.root.findAllByType('ChangedFilesTreeList' as any)).toHaveLength(0);

        const toggle = tree!.root.findAll((node: any) => node.props?.testID === 'repository-tree-filter-changed');
        expect(toggle.length).toBeGreaterThanOrEqual(1);

        await act(async () => {
            toggle[0]!.props.onPress();
        });

        expect(tree!.root.findAllByType('RepositoryTreeList' as any)).toHaveLength(0);
        expect(tree!.root.findAllByType('ChangedFilesTreeList' as any)).toHaveLength(1);
    });

    it('renders a collapse-all button when folders are expanded', async () => {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        setExpandedPathsSpy.mockClear();

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={vi.fn()} />);
        });

        const collapse = tree!.root.findAll((node: any) => node.props?.testID === 'repository-tree-collapse-all');
        expect(collapse.length).toBeGreaterThanOrEqual(1);

        await act(async () => {
            collapse[0]!.props.onPress();
        });

        expect(setExpandedPathsSpy).toHaveBeenCalledWith('s1', []);
    });
});
