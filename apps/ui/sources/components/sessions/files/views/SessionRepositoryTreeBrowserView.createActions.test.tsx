import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const promptSpy = vi.fn(async (..._args: any[]) => null as any);
const alertSpy = vi.fn((..._args: any[]) => {});
const writeFileSpy = vi.fn(async (..._args: any[]) => ({ success: true } as any));
const createDirectorySpy = vi.fn(async (..._args: any[]) => ({ success: true } as any));
const setExpandedSpy = vi.fn();
const safePathSpy = vi.fn((value: string) => value === 'src/new-file.ts' || value === 'src/new-folder');

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
    storage: { getState: () => ({ setSessionRepositoryTreeExpandedPaths: setExpandedSpy }) },
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

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: { invalidateFromUser: () => {} },
}));

vi.mock('@/sync/domains/input/suggestionFile', () => ({
    fileSearchCache: { clearCache: vi.fn() },
    searchFiles: vi.fn(async () => []),
}));

const mountCount = { current: 0 };
vi.mock('@/components/sessions/files/content/RepositoryTreeList', () => ({
    RepositoryTreeList: () => {
        React.useEffect(() => {
            mountCount.current += 1;
        }, []);
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
        prompt: (...args: any[]) => promptSpy(...args),
        alert: (...args: any[]) => alertSpy(...args),
    },
}));

vi.mock('@/sync/ops', () => ({
    sessionWriteFile: (...args: any[]) => writeFileSpy(...args),
    sessionCreateDirectory: (...args: any[]) => createDirectorySpy(...args),
}));

vi.mock('@/utils/path/isSafeWorkspaceRelativePath', () => ({
    isSafeWorkspaceRelativePath: (value: string) => safePathSpy(value),
}));

vi.mock('@/components/sessions/files/repositoryTree/computeExpandedPathsForReveal', () => ({
    computeExpandedPathsForReveal: ({ expandedPaths }: any) => expandedPaths,
}));

describe('SessionRepositoryTreeBrowserView (create actions)', () => {
    it('creates a file and opens it pinned', async () => {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        mountCount.current = 0;
        promptSpy.mockResolvedValueOnce('src/new-file.ts');
        writeFileSpy.mockClear();
        alertSpy.mockClear();

        const onOpenFile = vi.fn();
        const onOpenFilePinned = vi.fn();

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SessionRepositoryTreeBrowserView
                    sessionId="s1"
                    onOpenFile={onOpenFile}
                    onOpenFilePinned={onOpenFilePinned}
                />
            );
        });

        expect(mountCount.current).toBe(1);

        const createFile = tree!.root.findAll((node: any) => node.props?.testID === 'repository-tree-create-file');
        expect(createFile.length).toBeGreaterThan(0);

        await act(async () => {
            createFile[0]!.props.onPress();
        });

        expect(writeFileSpy).toHaveBeenCalledWith('s1', 'src/new-file.ts', '', null);
        expect(onOpenFilePinned).toHaveBeenCalledWith('src/new-file.ts');
        expect(alertSpy).toHaveBeenCalledTimes(0);
    });

    it('shows an error when create file path is invalid', async () => {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        promptSpy.mockResolvedValueOnce('../bad');
        alertSpy.mockClear();
        writeFileSpy.mockClear();

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SessionRepositoryTreeBrowserView
                    sessionId="s1"
                    onOpenFile={vi.fn()}
                />
            );
        });

        const createFile = tree!.root.findAll((node: any) => node.props?.testID === 'repository-tree-create-file');
        await act(async () => {
            createFile[0]!.props.onPress();
        });

        expect(writeFileSpy).toHaveBeenCalledTimes(0);
        expect(alertSpy).toHaveBeenCalledTimes(1);
    });

    it('creates a directory', async () => {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        promptSpy.mockResolvedValueOnce('src/new-folder');
        createDirectorySpy.mockClear();
        alertSpy.mockClear();

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SessionRepositoryTreeBrowserView
                    sessionId="s1"
                    onOpenFile={vi.fn()}
                />
            );
        });

        const createFolder = tree!.root.findAll((node: any) => node.props?.testID === 'repository-tree-create-folder');
        expect(createFolder.length).toBeGreaterThan(0);

        await act(async () => {
            createFolder[0]!.props.onPress();
        });

        expect(createDirectorySpy).toHaveBeenCalledWith('s1', 'src/new-folder');
        expect(alertSpy).toHaveBeenCalledTimes(0);
    });
});
