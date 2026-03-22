import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                                Platform: {
                                                    OS: 'ios',
                                                    select: (spec: Record<string, unknown>) =>
                                                        spec && Object.prototype.hasOwnProperty.call(spec, 'ios') ? (spec as any).ios : (spec as any).default,
                                                },
                                            }
    );
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

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            dark: false,
            colors: {
                text: '#000',
                textSecondary: '#666',
                accent: {
                    blue: '#06f',
                    indigo: '#33f',
                    orange: '#f80',
                    purple: '#a0f',
                    green: '#0a0',
                    red: '#f00',
                    yellow: '#fc0',
                },
                groupped: { background: '#F5F5F5', chevron: '#C7C7CC', sectionTitle: '#8E8E93' },
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
                divider: '#ddd',
                modal: { border: '#ddd' },
                shadow: { color: '#000', opacity: 0.2 },
            },
        },
    });
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

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

vi.mock('@/components/sessions/files/content/SearchResultsList', () => ({
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
const invalidateFromUserSpy = vi.fn();
vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        storage: { getState: () => ({ setSessionRepositoryTreeExpandedPaths: vi.fn() }) } as any,
        useSession: () => ({ active: sessionActive, metadata: { machineId: 'm1', host: 'mbp', path: sessionPath } }) as any,
        useProjectForSession: () => ({ key: { machineId: 'm1', path: projectPath } }) as any,
        useAllMachines: () => (
            machineReachable
                ? [{ id: 'm1', active: true, activeAt: 1, metadata: { host: 'mbp', platform: 'darwin', happyCliVersion: '0', happyHomeDir: '/tmp/.h', homeDir: '/tmp' } }]
                : [{ id: 'm1', active: false, activeAt: 1, metadata: { host: 'mbp', platform: 'darwin', happyCliVersion: '0', happyHomeDir: '/tmp/.h', homeDir: '/tmp' } }]
        ) as any,
        useMachine: () => ({ id: 'm1' }) as any,
        useSessionRepositoryTreeExpandedPaths: () => [],
        useSessionProjectScmSnapshot: () => null,
    });
});

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

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

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
    const input = screen.findByTestId('repository-tree-search');
    expect(input).toBeTruthy();
    await act(async () => {
        input?.props.onChangeText(value);
    });
}

async function settleSearchEffects() {
    await flushHookEffects({ advanceTimersMs: 200, cycles: 2 });
}

describe('SessionRepositoryTreeBrowserView', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        searchFilesSpy.mockReset();
        latestWorkspaceTransferParams = null;
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
        await settleSearchEffects();

        expect(screen.findByTestId('search-results:src/api.ts')).toBeTruthy();

        await act(async () => {
            screen.pressByTestId('search-results:src/api.ts');
        });

        expect(searchFilesSpy).toHaveBeenCalled();
        expect(onOpenFile).toHaveBeenCalledWith('src/api.ts');
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
        await settleSearchEffects();

        expect(screen.findByTestId('search-results:before.txt')).toBeTruthy();
        expect(searchFilesSpy).toHaveBeenCalledTimes(1);

        await act(async () => {
            await latestWorkspaceTransferParams.onAfterUploadSuccess();
        });
        await settleSearchEffects();

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
