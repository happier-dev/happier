import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

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
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            storage: { getState: () => ({ setSessionRepositoryTreeExpandedPaths: vi.fn() }) } as any,
            useSession: () => ({ active: sessionActive, metadata: { machineId: 'm1', host: 'mbp', path: sessionPath } }) as any,
            useProjectForSession: () => ({ key: { serverId: 'server', machineId: 'm1', rootPath: projectPath } }) as any,
            useAllMachines: () => (
                machineReachable
                    ? [{ id: 'm1', active: true, activeAt: 1, metadata: { host: 'mbp', platform: 'darwin', happyCliVersion: '0', happyHomeDir: '/tmp/.h', homeDir: '/tmp' } }]
                    : [{ id: 'm1', active: false, activeAt: 1, metadata: { host: 'mbp', platform: 'darwin', happyCliVersion: '0', happyHomeDir: '/tmp/.h', homeDir: '/tmp' } }]
            ) as any,
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
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props),
}));

let latestWorkspaceTransferParams: any = null;
vi.mock('@/hooks/session/files/useWorkspaceFileTransfers', () => ({
    useWorkspaceFileTransfers: (params: any) => {
        latestWorkspaceTransferParams = params;
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

vi.mock('@/components/sessions/files/content/RepositoryTreeList', () => ({
    RepositoryTreeList: (props: any) => React.createElement('View', { ...props, testID: 'repository-tree-list' }),
}));

const searchFilesSpy = vi.fn();
vi.mock('@/sync/domains/input/suggestionFile', () => ({
    searchFiles: (...args: any[]) => searchFilesSpy(...args),
    fileSearchCache: { clearCache: vi.fn() },
}));

const searchWorkspaceFilesSpy = vi.fn();
vi.mock('@/sync/domains/workspaces/files/workspaceFileSearch', () => ({
    searchWorkspaceFiles: (...args: any[]) => searchWorkspaceFilesSpy(...args),
    workspaceFileSearchCache: { clearCache: vi.fn() },
}));

vi.mock('@/components/projects/files/WorkspaceRepositoryTreeList', () => ({
    WorkspaceRepositoryTreeList: (props: any) => React.createElement('View', { ...props, testID: 'workspace-repository-tree-list' }),
}));

vi.mock('@/components/workspaces/files/repositoryTree/SearchResultsList', () => ({
    SearchResultsList: (props: any) => {
        const first = props.searchResults?.[0];
        return React.createElement('View' as any, {
            testID: first ? `search-results:${first.fullPath}` : 'search-results:empty',
            onPress: () => props.onFilePress?.(first),
        });
    },
}));

let sessionActive = true;
let machineReachable = true;
let sessionPath: string | null = null;
let projectPath: string | null = '/repo';
let machineRpcTargetAvailable = true;
let workspaceTargetAvailable = true;
const invalidateFromUserSpy = vi.fn();

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({
        machineReachable,
        machineOnline: machineReachable,
        machineRpcTargetAvailable,
    }),
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
                workspaceCacheKey: 'server:m1:/repo',
                machineId: 'm1',
                rootPath: '/repo',
                serverId: 'server',
            }
            : null
    ),
}));

vi.mock('@/sync/ops/workspaceFileSystem', () => ({
    workspaceWriteFile: vi.fn(async () => ({ success: true })),
    workspaceCreateDirectory: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/utils/path/isSafeWorkspaceRelativePath', () => ({
    isSafeWorkspaceRelativePath: () => true,
}));

vi.mock('@/components/workspaces/files/repositoryTree/computeExpandedPathsForReveal', () => ({
    computeExpandedPathsForReveal: ({ expandedPaths }: any) => expandedPaths,
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
        searchWorkspaceFilesSpy.mockReset();
        latestWorkspaceTransferParams = null;
        sessionActive = true;
        machineReachable = true;
        machineRpcTargetAvailable = true;
        workspaceTargetAvailable = true;
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

        expect(screen.findAllByTestId('workspace-repository-tree-list')).toHaveLength(1);
    });

    it('can hide the internal search bar', async () => {
        const { screen } = await renderRepositoryTreeBrowserView({
            showSearchBar: false,
        });

        expect(screen.findByTestId('repository-tree-search')).toBeNull();
    });

    it('searches via searchFiles and calls onOpenFile from results', async () => {
        searchWorkspaceFilesSpy.mockResolvedValueOnce([
            { fileName: 'api.ts', filePath: 'src/', fullPath: 'src/api.ts', fileType: 'file' },
        ]);

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
        expect(searchWorkspaceFilesSpy).toHaveBeenCalledTimes(1);

        await act(async () => {
            await latestWorkspaceTransferParams.onAfterUploadSuccess();
        });
        await waitForTestId(screen, 'search-results:after.txt');

        expect(searchWorkspaceFilesSpy).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId('search-results:after.txt')).toBeTruthy();
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
