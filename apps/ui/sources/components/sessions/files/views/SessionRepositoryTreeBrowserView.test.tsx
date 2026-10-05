import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const stableExpandedPaths = vi.hoisted(() => [] as string[]);
const setExpandedPathsSpy = vi.hoisted(() => vi.fn());

installSessionFilesViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (spec: Record<string, unknown>) =>
                    spec && Object.prototype.hasOwnProperty.call(spec, 'ios') ? (spec as any).ios : (spec as any).default,
            },
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: { getState: () => ({ getSessionRepositoryTreeExpandedPaths: () => stableExpandedPaths, setSessionRepositoryTreeExpandedPaths: setExpandedPathsSpy }) } as any,
            useSession: () => ({ active: sessionActive, metadata: { machineId: 'm1', host: 'mbp', path: sessionPath } }) as any,
            useProjectForSession: () => ({ key: { serverId: workspaceServerId, machineId: 'm1', rootPath: projectPath } }) as any,
            useAllMachines: () => (
                machineReachable
                    ? [{ id: 'm1', active: true, activeAt: 1, metadata: { host: 'mbp', platform: 'darwin', happyCliVersion: '0', happyHomeDir: '/tmp/.h', homeDir: '/tmp' } }]
                    : [{ id: 'm1', active: false, activeAt: 1, metadata: { host: 'mbp', platform: 'darwin', happyCliVersion: '0', happyHomeDir: '/tmp/.h', homeDir: '/tmp' } }]
            ) as any,
            useMachine: () => ({ id: 'm1' }) as any,
            useSessionRepositoryTreeExpandedPaths: () => stableExpandedPaths,
            useSessionProjectScmSnapshot: () => null,
            useSessionDirectoryKind: () => sessionDirectoryKind,
        });
    },
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

let latestWorkspaceTransferParams: any = null;
const workspaceTransferApi = {
    uploadState: { status: 'idle' },
    downloadState: { status: 'idle' },
    startUploads: vi.fn(async () => ({ ok: true })),
    cancelUploads: vi.fn(),
    startDownload: vi.fn(async () => ({ ok: true })),
    cancelDownload: vi.fn(),
};
vi.mock('@/hooks/session/files/useWorkspaceFileTransfers', () => ({
    useWorkspaceFileTransfers: (params: any) => {
        latestWorkspaceTransferParams = params;
        return workspaceTransferApi;
    },
}));

const searchFilesSpy = vi.fn();
vi.mock('@/sync/domains/input/suggestionFile', () => ({
    searchFiles: (...args: any[]) => searchFilesSpy(...args),
    fileSearchCache: { clearCache: vi.fn() },
}));

const searchWorkspaceFilesSpy = vi.fn();
// RPC boundary: keep the filename owner and shared query lifecycle real.
vi.mock('@/sync/ops/machineWorkspaceFileList', () => ({
    machineWorkspaceFileList: (...args: unknown[]) => searchWorkspaceFilesSpy(...args),
}));
// The tree reaches the real exact-Home credential owner; secure storage is the boundary.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
            getCredentialsForServerUrl: async () => ({
                token: `header.${Buffer.from(JSON.stringify({ sub: 'tree-account' })).toString('base64')}.signature`,
            }),
        },
    });
});

let workspaceRepositoryTreeListProps: any = null;
vi.mock('@/components/projects/files/WorkspaceRepositoryTreeList', () => ({
    WorkspaceRepositoryTreeList: (props: any) => {
        workspaceRepositoryTreeListProps = props;
        return React.createElement('View', { ...props, testID: 'workspace-repository-tree-list' });
    },
}));

vi.mock('@/components/workspaces/files/repositoryTree/SearchResultsList', () => ({
    SearchResultsList: (props: any) => {
        const first = props.searchResults?.[0];
        return React.createElement('View' as any, {
            testID: first ? `search-results:${first.fullPath}` : 'search-results:empty',
            onPress: () => first?.fileType === 'folder' ? props.onFolderPress?.(first) : props.onFilePress?.(first),
        });
    },
}));

let sessionActive = true;
let sessionDirectoryKind: 'path' | 'managed' | null = 'path';
let machineReachable = true;
let sessionPath: string | null = null;
let projectPath: string | null = '/repo';
let machineRpcTargetAvailable = true;
let workspaceTargetAvailable = true;
let workspaceRootPath = '/repo';
let workspaceServerId = 'server';
const invalidateFromUserSpy = vi.fn();

vi.mock('@/components/sessions/agents/presentation/useSessionMachineName', () => ({
    useSessionMachineName: () => 'MacBook Pro',
}));

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({
        machineReachable,
        machineOnline: machineReachable,
        machineRpcTargetAvailable,
    }),
}));

vi.mock('@/hooks/session/useSessionWorkspaceTarget', () => ({
    useSessionWorkspaceTarget: () => (
        workspaceTargetAvailable
            ? {
                workspaceCacheKey: `${workspaceServerId}:m1:${workspaceRootPath}`,
                machineId: 'm1',
                rootPath: workspaceRootPath,
                serverId: workspaceServerId,
            }
            : null
    ),
}));

vi.mock('@/components/workspaces/scm/states', () => ({
    SourceControlSessionInactiveState: () =>
        React.createElement('View', { testID: 'source-control-session-inactive-state' }),
    SourceControlUnavailableState: (props: any) => React.createElement('View', { ...props, testID: 'source-control-unavailable-state' }),
}));

vi.mock('@/sync/domains/session/resolveWorkspaceTargetForSession', () => ({
    resolveWorkspaceTargetForSession: () => (
        workspaceTargetAvailable
            ? {
                workspaceCacheKey: `${workspaceServerId}:m1:${workspaceRootPath}`,
                machineId: 'm1',
                rootPath: workspaceRootPath,
                serverId: workspaceServerId,
            }
            : null
    ),
}));

vi.mock('@/sync/ops/workspaceFileSystem', () => ({
    workspaceWriteFile: vi.fn(async () => ({ success: true })),
    workspaceCreateDirectory: vi.fn(async () => ({ success: true })),
}));



vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: { invalidateFromUser: (sessionId: string) => invalidateFromUserSpy(sessionId) },
}));

async function renderRepositoryTreeBrowserView(
    overrides: Partial<React.ComponentProps<typeof import('./SessionRepositoryTreeBrowserView').SessionRepositoryTreeBrowserView>> = {},
) {
    const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
    const onOpenFile = overrides.onOpenFile ?? vi.fn();
    const screen = await renderScreen(
        <SessionRepositoryTreeBrowserView
            sessionId="s1"
            onOpenFile={onOpenFile}
            {...overrides}
        />,
    );

    return {
        screen,
        onOpenFile,
        SessionRepositoryTreeBrowserView,
    };
}

async function updateSearchQuery(screen: Awaited<ReturnType<typeof renderRepositoryTreeBrowserView>>['screen'], value: string) {
    expect(screen.findByTestId('repository-tree-search')).toBeTruthy();
    await act(async () => {
        screen.changeTextByTestId('repository-tree-search', value);
    });
}

async function waitForTestId(screen: Awaited<ReturnType<typeof renderRepositoryTreeBrowserView>>['screen'], testID: string) {
    const timeoutMs = 1000;
    const pollMs = 5;
    const start = Date.now();

    while (!screen.findByTestId(testID)) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Timed out waiting for testID "${testID}"`);
        }

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, pollMs));
        });
    }
}

describe('SessionRepositoryTreeBrowserView', () => {
    beforeEach(async () => {
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        workspaceServerId = (await upsertServerProfile({ serverUrl: 'https://tree.example.test' })).id;
        setExpandedPathsSpy.mockClear();
        searchFilesSpy.mockReset();
        searchWorkspaceFilesSpy.mockReset();
        const { workspaceFileSearchCache } = await import('@/sync/domains/workspaces/files/workspaceFileSearch');
        workspaceFileSearchCache.clearAll();
        latestWorkspaceTransferParams = null;
        workspaceRepositoryTreeListProps = null;
        workspaceTransferApi.startUploads.mockClear();
        workspaceTransferApi.cancelUploads.mockClear();
        workspaceTransferApi.startDownload.mockClear();
        workspaceTransferApi.cancelDownload.mockClear();
        sessionActive = true;
        sessionDirectoryKind = 'path';
        machineReachable = true;
        machineRpcTargetAvailable = true;
        workspaceTargetAvailable = true;
        workspaceRootPath = '/repo';
        sessionPath = null;
        projectPath = '/repo';
        invalidateFromUserSpy.mockReset();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    it('shows the repository tree when the query is empty', async () => {
        const { screen } = await renderRepositoryTreeBrowserView();

        expect(screen.findAllByTestId('workspace-repository-tree-list')).toHaveLength(1);
    });

    it('keeps repository tree action props stable across unchanged parent rerenders', async () => {
        const { screen } = await renderRepositoryTreeBrowserView();
        const firstProps = workspaceRepositoryTreeListProps;
        expect(firstProps).toBeTruthy();

        await act(async () => {
            firstProps.onRootLoadingChange?.(true);
        });

        const nextProps = workspaceRepositoryTreeListProps;
        expect(nextProps).toBeTruthy();
        expect(nextProps.theme).toBe(firstProps.theme);
        expect(nextProps.onExpandedPathsChange).toBe(firstProps.onExpandedPathsChange);
        expect(nextProps.renderRowActions).toBe(firstProps.renderRowActions);
        expect(screen.findAllByTestId('workspace-repository-tree-list')).toHaveLength(1);
    });

    it('titles a no-folder session\'s tree "Session files" and names its root that way', async () => {
        sessionDirectoryKind = 'managed';
        const { screen } = await renderRepositoryTreeBrowserView();

        const heading = screen.findByTestId('repository-tree-session-files-root');
        expect(heading).toBeTruthy();
        expect(heading?.findAll((node) => node.props.children === 'session.folderless.sessionFiles').length).toBeGreaterThan(0);
        // The root is named the same way wherever the pane names it (drop destination).
        expect(screen.findAll((node) => node.props.destinationLabel === 'session.folderless.sessionFiles').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('workspace-repository-tree-list')).toHaveLength(1);
    });

    it('keeps a folder session\'s tree without a root heading', async () => {
        const { screen } = await renderRepositoryTreeBrowserView();

        expect(screen.findByTestId('repository-tree-session-files-root')).toBeNull();
        expect(screen.findAll((node) => node.props.destinationLabel === 'files.projectRoot').length).toBeGreaterThan(0);
    });

    it('can hide the internal search bar', async () => {
        const { screen } = await renderRepositoryTreeBrowserView({
            showSearchBar: false,
        });

        expect(screen.findByTestId('repository-tree-search')).toBeNull();
    });

    it('reveals a matching folder in the tree without opening or replacing file details', async () => {
        searchWorkspaceFilesSpy.mockResolvedValueOnce({ ok: true, paths: ['src/nested/file.ts'], truncated: false });
        const { screen, onOpenFile } = await renderRepositoryTreeBrowserView();
        await updateSearchQuery(screen, 'nested');
        await waitForTestId(screen, 'search-results:src/nested/');
        await screen.pressByTestIdAsync('search-results:src/nested/');
        expect(screen.findByTestId('repository-tree-search')?.props.value).toBe('');
        expect(setExpandedPathsSpy).toHaveBeenCalledWith('s1', ['src', 'src/nested']);
        expect(workspaceRepositoryTreeListProps.revealRequest?.path).toBe('src/nested');
        expect(onOpenFile).not.toHaveBeenCalled();
    });

    it('searches via the filename owner and calls onOpenFile from results', async () => {
        searchWorkspaceFilesSpy.mockResolvedValueOnce({ ok: true, paths: ['src/api.ts'], truncated: false });

        const { screen, onOpenFile } = await renderRepositoryTreeBrowserView();

        await updateSearchQuery(screen, 'api');
        await waitForTestId(screen, 'search-results:src/api.ts');

        expect(screen.findByTestId('search-results:src/api.ts')).toBeTruthy();

        await screen.pressByTestIdAsync('search-results:src/api.ts');

        expect(searchWorkspaceFilesSpy).toHaveBeenCalled();
        expect(onOpenFile).toHaveBeenCalledWith('src/api.ts');
    });

    it('reruns file search after upload success when the query stays the same', async () => {
        searchWorkspaceFilesSpy
            .mockResolvedValueOnce({ ok: true, paths: ['before-manual-qa-upload.txt'], truncated: false })
            .mockResolvedValueOnce({ ok: true, paths: ['after-manual-qa-upload.txt'], truncated: false });

        const { screen } = await renderRepositoryTreeBrowserView();

        await updateSearchQuery(screen, 'manual-qa-upload');
        await waitForTestId(screen, 'search-results:before-manual-qa-upload.txt');

        expect(screen.findByTestId('search-results:before-manual-qa-upload.txt')).toBeTruthy();
        expect(searchWorkspaceFilesSpy).toHaveBeenCalledTimes(1);

        await act(async () => {
            await latestWorkspaceTransferParams.onAfterUploadSuccess();
        });
        await waitForTestId(screen, 'search-results:after-manual-qa-upload.txt');

        expect(searchWorkspaceFilesSpy).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId('search-results:after-manual-qa-upload.txt')).toBeTruthy();
    });

    it('retains previous query rows while searching but never shows them for another session', async () => {
        searchWorkspaceFilesSpy.mockResolvedValueOnce({ ok: true, paths: ['src/api.ts'], truncated: false });
        const { screen, SessionRepositoryTreeBrowserView } = await renderRepositoryTreeBrowserView();
        await updateSearchQuery(screen, 'api');
        await waitForTestId(screen, 'search-results:src/api.ts');
        searchWorkspaceFilesSpy.mockImplementation(() => new Promise(() => {}));
        await updateSearchQuery(screen, 'api.ts');
        expect(screen.findByTestId('search-results:src/api.ts')).not.toBeNull();
        workspaceRootPath = '/other';
        await screen.update(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={vi.fn()} searchQuery="api.ts" />);
        expect(screen.findByTestId('search-results:src/api.ts') === null).toBe(true);
        workspaceRootPath = '/repo';
        await screen.update(<SessionRepositoryTreeBrowserView sessionId="s2" onOpenFile={vi.fn()} searchQuery="api.ts" />);
        expect(screen.findByTestId('search-results:src/api.ts') === null).toBe(true);
    });

    /**
     * The search owner (`searchWorkspaceFiles`) accepts an AbortSignal that reaches the
     * machine ripgrep RPC. The view used to debounce with a timer and drop stale results
     * through a `cancelled` boolean while ignoring that signal — so every keystroke left the
     * previous remote search running to completion. Changing the query must abort the
     * in-flight RPC, and the newest call must carry a fresh, live signal.
     */
    it('aborts the in-flight file search RPC when the query changes', async () => {
        searchWorkspaceFilesSpy.mockImplementation((_machineId: string, _input: unknown, options: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
                options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            }));

        const { screen } = await renderRepositoryTreeBrowserView();

        await updateSearchQuery(screen, 'first');
        await waitForTestId(screen, 'search-results:empty');
        while (searchWorkspaceFilesSpy.mock.calls.length === 0) {
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 5));
            });
        }
        const firstSignal = searchWorkspaceFilesSpy.mock.calls[0]?.[2]?.signal as AbortSignal;
        expect(firstSignal).toBeInstanceOf(AbortSignal);
        expect(firstSignal.aborted).toBe(false);

        await updateSearchQuery(screen, 'second');
        while (searchWorkspaceFilesSpy.mock.calls.length < 2) {
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 5));
            });
        }
        const secondSignal = searchWorkspaceFilesSpy.mock.calls[1]?.[2]?.signal as AbortSignal;

        expect(firstSignal.aborted).toBe(true);
        expect(secondSignal.aborted).toBe(false);
    });

    it('renders repository tree when the session is inactive but machine is reachable', async () => {
        sessionActive = false;

        const { screen } = await renderRepositoryTreeBrowserView();

        expect(screen.findByTestId('source-control-session-inactive-state')).toBeNull();
        expect(screen.findAllByTestId('workspace-repository-tree-list')).toHaveLength(1);
    });

    it('renders repository tree when session is inactive and machine is offline but target is resolvable', async () => {
        sessionActive = false;
        machineReachable = false;
        machineRpcTargetAvailable = true;

        const { screen } = await renderRepositoryTreeBrowserView();

        expect(screen.findByTestId('source-control-session-inactive-state')).toBeNull();
        expect(screen.findAllByTestId('workspace-repository-tree-list')).toHaveLength(1);
    });

    it('renders repository tree when the project mapping is missing but the workspace target is resolvable', async () => {
        projectPath = null;

        const { screen } = await renderRepositoryTreeBrowserView();

        expect(screen.findByTestId('source-control-unavailable-state')).toBeNull();
        expect(screen.findAllByTestId('workspace-repository-tree-list')).toHaveLength(1);
    });

    it('shows an unavailable state when the session has no resolvable workspace target', async () => {
        sessionActive = false;
        sessionPath = '';
        projectPath = '';
        machineRpcTargetAvailable = false;
        workspaceTargetAvailable = false;

        const { screen } = await renderRepositoryTreeBrowserView();

        expect(screen.findByTestId('source-control-session-inactive-state')).toBeNull();
        expect(screen.findAllByTestId('source-control-unavailable-state')).toHaveLength(1);
    });

    it('warms SCM badges when machine RPC target availability flips to available', async () => {
        machineRpcTargetAvailable = false;

        const { screen, SessionRepositoryTreeBrowserView } = await renderRepositoryTreeBrowserView();

        expect(invalidateFromUserSpy).not.toHaveBeenCalled();

        machineRpcTargetAvailable = true;

        await screen.update(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={vi.fn()} />);

        expect(invalidateFromUserSpy).toHaveBeenCalledTimes(1);
        expect(invalidateFromUserSpy).toHaveBeenCalledWith('s1');
    });
});
