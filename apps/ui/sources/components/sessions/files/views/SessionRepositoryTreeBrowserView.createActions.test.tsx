import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const promptSpy = vi.fn(async (..._args: any[]) => null as any);
const alertSpy = vi.fn((..._args: any[]) => {});
const writeFileSpy = vi.fn(async (..._args: any[]) => ({ success: true } as any));
const createDirectorySpy = vi.fn(async (..._args: any[]) => ({ success: true } as any));
const startUploadsSpy = vi.fn(async (..._args: any[]) => ({ ok: true } as any));
const setExpandedSpy = vi.fn();
const safePathSpy = vi.fn((value: string) => value === 'src/new-file.ts' || value === 'src/new-folder' || value === 'src/uploads');
let sessionActive = true;
let machineRpcTargetAvailable = true;

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
    Typography: { default: () => ({}), mono: () => ({}) },
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

vi.mock('@/sync/domains/state/storage', () => ({
    storage: { getState: () => ({ setSessionRepositoryTreeExpandedPaths: setExpandedSpy }) },
    useSession: () => ({ active: sessionActive, metadata: { machineId: 'm1' } }),
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
        machineReachable: machineRpcTargetAvailable,
        machineOnline: machineRpcTargetAvailable,
        machineRpcTargetAvailable,
    }),
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
    beforeEach(() => {
        sessionActive = true;
        machineRpcTargetAvailable = true;
        promptSpy.mockReset();
        alertSpy.mockClear();
        writeFileSpy.mockClear();
        createDirectorySpy.mockClear();
        startUploadsSpy.mockClear();
        setExpandedSpy.mockClear();
        safePathSpy.mockClear();
        safePathSpy.mockImplementation((value: string) => value === 'src/new-file.ts' || value === 'src/new-folder' || value === 'src/uploads');
    });

    it('keeps create actions enabled when the session is inactive but the machine target is available', async () => {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        sessionActive = false;
        machineRpcTargetAvailable = true;

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SessionRepositoryTreeBrowserView
                    sessionId="s1"
                    onOpenFile={vi.fn()}
                />
            );
        });

        const createFileButton = tree!.root.findByProps({ testID: 'repository-tree-create-file' });
        const uploadMenu = tree!.root.findByType('DropdownMenu' as any);
        expect(uploadMenu.props.items.find((item: any) => item.id === 'repository-tree-upload-files')?.disabled).toBe(false);
        expect(createFileButton.props.disabled).toBe(false);
    });

    it('disables create actions when no machine RPC target is available', async () => {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        machineRpcTargetAvailable = false;

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SessionRepositoryTreeBrowserView
                    sessionId="s1"
                    onOpenFile={vi.fn()}
                />
            );
        });

        const createFileButton = tree!.root.findByProps({ testID: 'repository-tree-create-file' });
        const uploadMenu = tree!.root.findByType('DropdownMenu' as any);
        expect(uploadMenu.props.items.find((item: any) => item.id === 'repository-tree-upload-files')?.disabled).toBe(true);
        expect(createFileButton.props.disabled).toBe(true);
    });

    it('renders stable web upload input testIDs for UI e2e', async () => {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SessionRepositoryTreeBrowserView
                    sessionId="s1"
                    onOpenFile={vi.fn()}
                />
            );
        });

        expect(tree!.root.findAllByProps({ 'data-testid': 'repository-tree-upload-input-files' })).toHaveLength(1);
        expect(tree!.root.findAllByProps({ 'data-testid': 'repository-tree-upload-input-folder' })).toHaveLength(1);
    });

    it('uses the selected upload destination for toolbar-triggered web uploads', async () => {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        promptSpy.mockResolvedValueOnce('src/uploads');
        startUploadsSpy.mockClear();

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SessionRepositoryTreeBrowserView
                    sessionId="s1"
                    onOpenFile={vi.fn()}
                />
            );
        });

        const uploadMenu = tree!.root.findByType('DropdownMenu' as any);
        await act(async () => {
            await uploadMenu.props.onSelect('repository-tree-upload-destination-select');
        });

        expect(promptSpy).toHaveBeenCalledWith(
            'settingsAttachments.workspaceDirectory.uploadsDirectory.promptTitle',
            'settingsAttachments.workspaceDirectory.uploadsDirectory.promptMessage',
            expect.objectContaining({
                defaultValue: '',
                placeholder: 'files.projectRoot',
            }),
        );

        const rerenderedUploadMenu = tree!.root.findByType('DropdownMenu' as any);
        expect(rerenderedUploadMenu.props.items.find((item: any) => item.id === 'repository-tree-upload-destination-select'))
            .toMatchObject({ subtitle: 'src/uploads' });

        const [fileInput] = tree!.root.findAllByProps({ 'data-testid': 'repository-tree-upload-input-files' });
        const file = { name: 'upload-source.txt' };

        await act(async () => {
            fileInput.props.onChange({
                target: {
                    files: [file],
                    value: 'upload-source.txt',
                },
            });
        });

        expect(startUploadsSpy).toHaveBeenCalledWith({
            entries: [
                {
                    kind: 'web',
                    file,
                    relativePath: 'upload-source.txt',
                },
            ],
            destinationDir: 'src/uploads',
        });
    });

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
