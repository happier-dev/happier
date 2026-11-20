import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
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
            useProjectForSession: () => ({ key: { machineId: 'm1', path: projectPath } }) as any,
            useAllMachines: () => (
                machineReachable
                    ? [{ id: 'm1', active: true, activeAt: 1, metadata: { host: 'mbp', platform: 'darwin', happyCliVersion: '0', happyHomeDir: '/tmp/.h', homeDir: '/tmp' } }]
                    : [{ id: 'm1', active: false, activeAt: 1, metadata: { host: 'mbp', platform: 'darwin', happyCliVersion: '0', happyHomeDir: '/tmp/.h', homeDir: '/tmp' } }]
            ) as any,
            useMachine: () => ({ id: 'm1' }) as any,
            useSessionRepositoryTreeExpandedPaths: () => stableExpandedPaths,
            useSessionProjectScmSnapshot: () => null,
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
const stableWorkspaceTransfers = {
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
        return stableWorkspaceTransfers;
    },
}));

let repositoryTreeListProps: any[] = [];
vi.mock('@/components/sessions/files/content/RepositoryTreeList', () => ({
    RepositoryTreeList: React.memo((props: any) => {
        repositoryTreeListProps.push(props);
        return React.createElement('View', { ...props, testID: 'repository-tree-list' });
    }),
}));

vi.mock('@/components/sessions/sessionMedia/SessionMediaGrid', () => ({
    SessionMediaGrid: (props: any) => React.createElement('View', { ...props, testID: 'session-media-grid' }),
}));

const searchFilesSpy = vi.fn();
const fileSuggestionScope = {
    machineId: 'm1',
    path: '/repo',
    serverId: 'server-1',
};
vi.mock('@/sync/domains/input/suggestionFile', () => ({
    searchFiles: (...args: any[]) => searchFilesSpy(...args),
    fileSearchCache: { clearCache: vi.fn() },
}));

vi.mock('@/sync/ops/resolveSessionFileSuggestionScope', () => ({
    resolveSessionFileSuggestionScope: () => fileSuggestionScope,
}));

let searchResultsListProps: any[] = [];
vi.mock('@/components/sessions/files/content/SearchResultsList', () => ({
    SearchResultsList: (props: any) => {
        searchResultsListProps.push(props);
        const first = props.searchResults?.[0];
        return React.createElement('View' as any, {
            testID: first ? `search-results:${first.fullPath}` : 'search-results:empty',
            onPress: () => first?.fileType === 'folder' ? props.onFolderPress?.(first) : props.onFilePress?.(first),
        });
    },
}));

let sessionActive = true;
let machineReachable = true;
let sessionPath: string | null = null;
let projectPath: string | null = '/repo';
let machineRpcTargetAvailable = true;
const invalidateFromUserSpy = vi.fn();

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({
        machineReachable,
        machineOnline: machineReachable,
        machineRpcTargetAvailable,
    }),
}));

vi.mock('@/components/sessions/sourceControl/states', () => ({
    SourceControlSessionInactiveState: () =>
        React.createElement('View', { testID: 'source-control-session-inactive-state' }),
}));

vi.mock('@/sync/ops', () => ({
    sessionWriteFile: vi.fn(async () => ({ success: true })),
    sessionCreateDirectory: vi.fn(async () => ({ success: true })),
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
    beforeEach(() => {
        searchFilesSpy.mockReset();
        setExpandedPathsSpy.mockClear();
        latestWorkspaceTransferParams = null;
        repositoryTreeListProps = [];
        searchResultsListProps = [];
        stableWorkspaceTransfers.startUploads.mockClear();
        stableWorkspaceTransfers.cancelUploads.mockClear();
        stableWorkspaceTransfers.startDownload.mockClear();
        stableWorkspaceTransfers.cancelDownload.mockClear();
        sessionActive = true;
        machineReachable = true;
        machineRpcTargetAvailable = true;
        sessionPath = null;
        projectPath = '/repo';
        invalidateFromUserSpy.mockReset();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    it('shows RepositoryTreeList when query is empty', async () => {
        const { screen } = await renderRepositoryTreeBrowserView();

        expect(screen.findAllByTestId('repository-tree-list')).toHaveLength(1);
    });

    it('keeps repository tree action props stable across unchanged parent rerenders', async () => {
        await renderRepositoryTreeBrowserView();
        const initialProps = repositoryTreeListProps.at(-1);
        expect(initialProps).toBeTruthy();
        expect(initialProps.theme).toBeTruthy();

        await act(async () => {
            initialProps.onRootLoadingChange(true);
        });

        const nextProps = repositoryTreeListProps.at(-1);
        expect(nextProps).toBeTruthy();
        expect(nextProps.theme).toBe(initialProps.theme);
        expect(nextProps.onRequestDownload).toBe(initialProps.onRequestDownload);
        expect(nextProps.onExpandedPathsChange).toBe(initialProps.onExpandedPathsChange);
    });

    it('offers the Session media tab first and swaps the tree for the media grid when selected', async () => {
        const { screen } = await renderRepositoryTreeBrowserView();

        expect(screen.findByTestId('repository-tree-list')).toBeTruthy();
        expect(screen.findByTestId('session-media-grid')).toBeNull();
        const tabIds = screen.root.findAll((node) => String(node.props?.testID ?? '').startsWith('repository-tree-visibility:'))
            .map((node) => String(node.props.testID));
        expect(tabIds.find((id) => !id.endsWith(':badge') && !id.endsWith(':focus-ring'))).toBe('repository-tree-visibility:session');

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('repository-tree-visibility:session'), 'onPress');
        });

        expect(screen.findByTestId('session-media-grid')?.props.sessionId).toBe('s1');
        expect(screen.findByTestId('repository-tree-list')).toBeNull();
    });

    it('lands on the Session media tab when asked to, then reports the request handled', async () => {
        const onViewRequestHandled = vi.fn();
        const { screen } = await renderRepositoryTreeBrowserView({ viewRequest: { view: 'session' }, onViewRequestHandled });

        expect(screen.findByTestId('session-media-grid')).not.toBeNull();
        expect(screen.findByTestId('repository-tree-list')).toBeNull();
        expect(onViewRequestHandled).toHaveBeenCalledTimes(1);
    });

    it('keeps the repository tree list stable when only scroll edge visibility changes', async () => {
        await renderRepositoryTreeBrowserView();
        const initialProps = repositoryTreeListProps.at(-1);
        expect(initialProps).toBeTruthy();

        await act(async () => {
            initialProps.onLayout({
                nativeEvent: { layout: { width: 320, height: 200 } },
            });
            initialProps.onContentSizeChange(320, 1000);
        });

        repositoryTreeListProps = [];

        await act(async () => {
            initialProps.onScroll({
                nativeEvent: {
                    contentOffset: { x: 0, y: 120 },
                    contentSize: { width: 320, height: 1000 },
                    layoutMeasurement: { width: 320, height: 200 },
                },
            });
        });

        const changedKeys = Object.keys(repositoryTreeListProps.at(-1) ?? {})
            .filter((key) => repositoryTreeListProps.at(-1)?.[key] !== initialProps[key]);
        expect(changedKeys).toEqual([]);
    });

    it('keeps repository tree file handlers stable while dispatching to the latest parent handlers', async () => {
        const initialOpenFile = vi.fn();
        const nextOpenFile = vi.fn();
        const initialOpenFilePinned = vi.fn();
        const nextOpenFilePinned = vi.fn();

        const { screen, SessionRepositoryTreeBrowserView } = await renderRepositoryTreeBrowserView({
            onOpenFile: initialOpenFile,
            onOpenFilePinned: initialOpenFilePinned,
        });
        const initialProps = repositoryTreeListProps.at(-1);
        expect(initialProps).toBeTruthy();

        await screen.update(
            <SessionRepositoryTreeBrowserView
                sessionId="s1"
                onOpenFile={nextOpenFile}
                onOpenFilePinned={nextOpenFilePinned}
            />,
        );

        const nextProps = repositoryTreeListProps.at(-1);
        expect(nextProps).toBeTruthy();
        expect(nextProps.onOpenFile).toBe(initialProps.onOpenFile);
        expect(nextProps.onOpenFilePinned).toBe(initialProps.onOpenFilePinned);

        nextProps.onOpenFile('src/api.ts');
        nextProps.onOpenFilePinned('src/api.ts');

        expect(initialOpenFile).not.toHaveBeenCalled();
        expect(initialOpenFilePinned).not.toHaveBeenCalled();
        expect(nextOpenFile).toHaveBeenCalledWith('src/api.ts');
        expect(nextOpenFilePinned).toHaveBeenCalledWith('src/api.ts');
    });

    it('can hide the internal search bar', async () => {
        const { screen } = await renderRepositoryTreeBrowserView({
            showSearchBar: false,
        });

        expect(screen.findByTestId('repository-tree-search')).toBeNull();
    });

    it('searches via searchFiles and calls onOpenFile from results', async () => {
        searchFilesSpy.mockResolvedValueOnce([
            { fileName: 'api.ts', filePath: 'src/', fullPath: 'src/api.ts', fileType: 'file' },
        ]);

        const { screen, onOpenFile } = await renderRepositoryTreeBrowserView();

        await updateSearchQuery(screen, 'api');
        await waitForTestId(screen, 'search-results:src/api.ts');

        expect(screen.findByTestId('search-results:src/api.ts')).toBeTruthy();

        await screen.pressByTestIdAsync('search-results:src/api.ts');

        expect(searchFilesSpy).toHaveBeenCalledWith(fileSuggestionScope, 'api', { limit: 200 });
        expect(onOpenFile).toHaveBeenCalledWith('src/api.ts');
    });

    it('reveals a matching folder in the tree without opening or replacing file details', async () => {
        searchFilesSpy.mockResolvedValueOnce([{ fileName: 'nested/', filePath: 'src/', fullPath: 'src/nested/', fileType: 'folder' }]);
        const { screen, onOpenFile } = await renderRepositoryTreeBrowserView();
        await updateSearchQuery(screen, 'nested');
        await waitForTestId(screen, 'search-results:src/nested/');
        await screen.pressByTestIdAsync('search-results:src/nested/');
        expect(screen.findByTestId('repository-tree-search')?.props.value).toBe('');
        expect(setExpandedPathsSpy).toHaveBeenCalledWith('s1', ['src', 'src/nested']);
        expect(repositoryTreeListProps.at(-1).revealRequest?.path).toBe('src/nested');
        expect(onOpenFile).not.toHaveBeenCalled();
    });

    it('retains previous query rows while searching but never shows them for another session', async () => {
        searchFilesSpy.mockResolvedValueOnce([
            { fileName: 'api.ts', filePath: 'src/', fullPath: 'src/api.ts', fileType: 'file' },
        ]);
        const { screen, SessionRepositoryTreeBrowserView } = await renderRepositoryTreeBrowserView();
        await updateSearchQuery(screen, 'api');
        await waitForTestId(screen, 'search-results:src/api.ts');
        searchFilesSpy.mockImplementation(() => new Promise(() => {}));
        await updateSearchQuery(screen, 'api.ts');
        expect(searchResultsListProps.at(-1).searchResults[0]?.fullPath).toBe('src/api.ts');
        expect(searchResultsListProps.at(-1).isSearching).toBe(true);
        await screen.update(<SessionRepositoryTreeBrowserView sessionId="s2" onOpenFile={vi.fn()} searchQuery="api.ts" />);
        expect(searchResultsListProps.at(-1).searchResults).toEqual([]);
    }, 300_000);

    it('keeps search result action props stable across unchanged parent rerenders', async () => {
        searchFilesSpy.mockResolvedValue([
            { fileName: 'api.ts', filePath: 'src/', fullPath: 'src/api.ts', fileType: 'file' },
        ]);
        const onOpenFile = vi.fn();

        const { screen, SessionRepositoryTreeBrowserView } = await renderRepositoryTreeBrowserView({ onOpenFile });

        await updateSearchQuery(screen, 'api');
        await waitForTestId(screen, 'search-results:src/api.ts');

        const initialProps = searchResultsListProps.at(-1);
        expect(initialProps).toBeTruthy();
        expect(initialProps.theme).toBeTruthy();

        await act(async () => {
            initialProps.onLayout?.({ nativeEvent: { layout: { width: 320, height: 400 } } });
            initialProps.onContentSizeChange?.(320, 2000);
        });

        const nextProps = searchResultsListProps.at(-1);
        expect(nextProps).toBeTruthy();
        expect(nextProps.theme).toBe(initialProps.theme);
        expect(nextProps.onFilePress).toBe(initialProps.onFilePress);
        expect(nextProps.onFilePressPinned).toBe(initialProps.onFilePressPinned);
    });

    it('keeps search result action props stable while dispatching to the latest parent handlers', async () => {
        searchFilesSpy.mockResolvedValue([
            { fileName: 'api.ts', filePath: 'src/', fullPath: 'src/api.ts', fileType: 'file' },
        ]);
        const initialOpenFile = vi.fn();
        const nextOpenFile = vi.fn();

        const { screen, SessionRepositoryTreeBrowserView } = await renderRepositoryTreeBrowserView({
            onOpenFile: initialOpenFile,
        });

        await updateSearchQuery(screen, 'api');
        await waitForTestId(screen, 'search-results:src/api.ts');

        const initialProps = searchResultsListProps.at(-1);
        expect(initialProps).toBeTruthy();

        await screen.update(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={nextOpenFile} />);

        const nextProps = searchResultsListProps.at(-1);
        expect(nextProps).toBeTruthy();
        expect(nextProps.onFilePress).toBe(initialProps.onFilePress);
        expect(nextProps.onFilePressPinned).toBe(initialProps.onFilePressPinned);

        nextProps.onFilePress({ fullPath: 'src/api.ts' });
        nextProps.onFilePressPinned({ fullPath: 'src/api.ts' });

        expect(initialOpenFile).not.toHaveBeenCalled();
        expect(nextOpenFile).toHaveBeenCalledTimes(2);
        expect(nextOpenFile).toHaveBeenCalledWith('src/api.ts');
    });

    it('reruns file search after upload success when the query stays the same', async () => {
        searchFilesSpy
            .mockResolvedValueOnce([
                { fileName: 'before.txt', filePath: '', fullPath: 'before.txt', fileType: 'file' },
            ])
            .mockResolvedValueOnce([
                { fileName: 'after.txt', filePath: '', fullPath: 'after.txt', fileType: 'file' },
        ]);

        const { screen } = await renderRepositoryTreeBrowserView();

        await updateSearchQuery(screen, 'manual-qa-upload');
        await waitForTestId(screen, 'search-results:before.txt');

        expect(screen.findByTestId('search-results:before.txt')).toBeTruthy();
        expect(searchFilesSpy).toHaveBeenCalledTimes(1);

        await act(async () => {
            await latestWorkspaceTransferParams.onAfterUploadSuccess();
        });
        await waitForTestId(screen, 'search-results:after.txt');

        expect(searchFilesSpy).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId('search-results:after.txt')).toBeTruthy();
    });

    it('renders repository tree when the session is inactive but machine is reachable', async () => {
        sessionActive = false;

        const { screen } = await renderRepositoryTreeBrowserView();

        expect(screen.findByTestId('source-control-session-inactive-state')).toBeNull();
        expect(screen.findAllByTestId('repository-tree-list')).toHaveLength(1);
    });

    it('renders repository tree when session is inactive and machine is offline but target is resolvable', async () => {
        sessionActive = false;
        machineReachable = false;
        machineRpcTargetAvailable = true;

        const { screen } = await renderRepositoryTreeBrowserView();

        expect(screen.findByTestId('source-control-session-inactive-state')).toBeNull();
        expect(screen.findAllByTestId('repository-tree-list')).toHaveLength(1);
    });

    it('still renders the repository tree when the session is inactive and no machine target is available', async () => {
        sessionActive = false;
        sessionPath = '';
        projectPath = '';
        machineRpcTargetAvailable = false;

        const { screen } = await renderRepositoryTreeBrowserView();

        expect(screen.findByTestId('source-control-session-inactive-state')).toBeNull();
        expect(screen.findAllByTestId('repository-tree-list')).toHaveLength(1);
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
