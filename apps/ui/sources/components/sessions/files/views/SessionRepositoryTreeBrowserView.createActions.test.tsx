import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';

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

installSessionFilesViewCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        const modalModuleMock = createModalModuleMock();
        modalModuleMock.spies.prompt.mockImplementation((...args: any[]) => promptSpy(...args));
        modalModuleMock.spies.alert.mockImplementation((...args: any[]) => alertSpy(...args));
        return modalModuleMock.module;
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            storage: { getState: () => ({ setSessionRepositoryTreeExpandedPaths: setExpandedSpy }) } as any,
            useSession: () => ({ active: sessionActive, metadata: { machineId: 'm1' } }) as any,
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

vi.mock('@/components/sessions/files/useSessionFileUploadAvailability', () => ({
    useSessionFileUploadAvailability: () => machineRpcTargetAvailable,
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
        return React.createElement('View', { testID: 'repository-tree-list' });
    },
}));

vi.mock('@/components/sessions/files/content/ChangedFilesTreeList', () => ({
    ChangedFilesTreeList: () => React.createElement('ChangedFilesTreeList'),
}));

vi.mock('@/components/sessions/files/content/SearchResultsList', () => ({
    SearchResultsList: () => React.createElement('SearchResultsList'),
}));

vi.mock('@/components/sessions/files/content/ChangedFilesReview', () => ({
    ChangedFilesReview: () => React.createElement('ChangedFilesReview'),
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
    afterEach(() => {
        standardCleanup();
    });

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

    async function renderRepositoryTreeBrowserView(
        overrides: Partial<React.ComponentProps<typeof import('./SessionRepositoryTreeBrowserView').SessionRepositoryTreeBrowserView>> = {},
    ) {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        return renderScreen(
            <SessionRepositoryTreeBrowserView
                sessionId="s1"
                onOpenFile={vi.fn()}
                {...overrides}
            />,
        );
    }

    it('keeps create actions enabled when the session is inactive but the machine target is available', async () => {
        sessionActive = false;
        machineRpcTargetAvailable = true;

        const screen = await renderRepositoryTreeBrowserView();

        const createFileButton = screen.findByTestId('repository-tree-create-file');
        const uploadMenu = screen.findByType('DropdownMenu' as any);
        expect(uploadMenu.props.items.find((item: any) => item.id === 'repository-tree-upload-files')?.disabled).toBe(false);
        expect(createFileButton?.props.disabled).toBe(false);
    });

    it('disables create actions when no machine RPC target is available', async () => {
        machineRpcTargetAvailable = false;

        const screen = await renderRepositoryTreeBrowserView();

        const createFileButton = screen.findByTestId('repository-tree-create-file');
        const uploadMenu = screen.findByType('DropdownMenu' as any);
        expect(uploadMenu.props.items.find((item: any) => item.id === 'repository-tree-upload-files')?.disabled).toBe(true);
        expect(createFileButton?.props.disabled).toBe(true);
    });

    it('renders stable web upload input testIDs for UI e2e', async () => {
        const screen = await renderRepositoryTreeBrowserView();

        expect(screen.findAllByProps({ 'data-testid': 'repository-tree-upload-input-files' })).toHaveLength(1);
        expect(screen.findAllByProps({ 'data-testid': 'repository-tree-upload-input-folder' })).toHaveLength(1);
    });

    it('uses the selected upload destination for toolbar-triggered web uploads', async () => {
        promptSpy.mockResolvedValueOnce('src/uploads');
        startUploadsSpy.mockClear();

        const screen = await renderRepositoryTreeBrowserView();

        const uploadMenu = screen.findByType('DropdownMenu' as any);
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

        const rerenderedUploadMenu = screen.findByType('DropdownMenu' as any);
        expect(rerenderedUploadMenu.props.items.find((item: any) => item.id === 'repository-tree-upload-destination-select'))
            .toMatchObject({ subtitle: 'src/uploads' });

        const [fileInput] = screen.findAllByProps({ 'data-testid': 'repository-tree-upload-input-files' });
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
        mountCount.current = 0;
        promptSpy.mockResolvedValueOnce('src/new-file.ts');
        writeFileSpy.mockClear();
        alertSpy.mockClear();

        const onOpenFile = vi.fn();
        const onOpenFilePinned = vi.fn();

        const screen = await renderRepositoryTreeBrowserView({
            onOpenFile,
            onOpenFilePinned,
        });

        expect(mountCount.current).toBe(1);

        expect(screen.findAllByTestId('repository-tree-create-file').length).toBeGreaterThan(0);

        await act(async () => {
            screen.pressByTestId('repository-tree-create-file');
        });

        expect(writeFileSpy).toHaveBeenCalledWith('s1', 'src/new-file.ts', '', null);
        expect(onOpenFilePinned).toHaveBeenCalledWith('src/new-file.ts');
        expect(alertSpy).toHaveBeenCalledTimes(0);
    });

    it('shows an error when create file path is invalid', async () => {
        promptSpy.mockResolvedValueOnce('../bad');
        alertSpy.mockClear();
        writeFileSpy.mockClear();

        const screen = await renderRepositoryTreeBrowserView();
        await act(async () => {
            screen.pressByTestId('repository-tree-create-file');
        });

        expect(writeFileSpy).toHaveBeenCalledTimes(0);
        expect(alertSpy).toHaveBeenCalledTimes(1);
    });

    it('creates a directory', async () => {
        promptSpy.mockResolvedValueOnce('src/new-folder');
        createDirectorySpy.mockClear();
        alertSpy.mockClear();

        const screen = await renderRepositoryTreeBrowserView();
        expect(screen.findAllByTestId('repository-tree-create-folder').length).toBeGreaterThan(0);

        await act(async () => {
            screen.pressByTestId('repository-tree-create-folder');
        });

        expect(createDirectorySpy).toHaveBeenCalledWith('s1', 'src/new-folder');
        expect(alertSpy).toHaveBeenCalledTimes(0);
    });
});
