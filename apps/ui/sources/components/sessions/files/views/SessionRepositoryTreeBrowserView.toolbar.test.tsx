import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const clearCacheSpy = vi.fn();
const clearRepositoryDirectoryCacheSpy = vi.fn();
const clearWorkspaceRepositoryDirectoryCacheSpy = vi.fn();
let latestTransferOptions: any = null;

installSessionFilesViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
        });
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            storage: { getState: () => ({ setSessionRepositoryTreeExpandedPaths: vi.fn() }) } as any,
            useSession: () => ({ active: true, metadata: { machineId: 'm1' } }) as any,
            useProjectForSession: () => ({ key: { serverId: 'server', machineId: 'm1', rootPath: '/repo' } }) as any,
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

vi.mock('@/components/workspaces/scm/states', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/workspaces/scm/states')>();
    return {
        ...actual,
        SourceControlSessionInactiveState: () => React.createElement('SourceControlSessionInactiveState'),
    };
});

vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
    resolveSessionMachineReachability: () => true,
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => true,
}));

vi.mock('@/components/sessions/agents/presentation/useSessionMachineName', () => ({
    useSessionMachineName: () => 'MacBook Pro',
}));

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({
        machineReachable: true,
        machineOnline: true,
        machineRpcTargetAvailable: true,
    }),
}));

vi.mock('@/hooks/session/useSessionWorkspaceTarget', () => ({
    useSessionWorkspaceTarget: () => ({
        workspaceCacheKey: 'server:m1:/repo',
        machineId: 'm1',
        rootPath: '/repo',
        serverId: 'server',
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

vi.mock('@/sync/domains/workspaces/files/workspaceRepositoryDirectory', () => ({
    clearCachedWorkspaceRepositoryDirectoryEntries: (input: { workspaceCacheKey: string }) => clearWorkspaceRepositoryDirectoryCacheSpy(input),
}));

const mountCount = { current: 0 };
const reloadCount = { current: 0 };
const workspaceRepositoryTreeRootLoading = { current: false };
const latestWorkspaceRepositoryTreeListProps = { current: null as any };
vi.mock('@/components/projects/files/WorkspaceRepositoryTreeList', () => ({
    WorkspaceRepositoryTreeList: (props: any) => {
        latestWorkspaceRepositoryTreeListProps.current = props;
        React.useEffect(() => {
            mountCount.current += 1;
        }, []);
        React.useEffect(() => {
            reloadCount.current += 1;
        }, [props?.reloadToken]);
        React.useEffect(() => {
            props?.onRootLoadingChange?.(workspaceRepositoryTreeRootLoading.current);
        }, [props]);
        return React.createElement('View', { testID: 'workspace-repository-tree-list' });
    },
}));

vi.mock('@/components/workspaces/files/repositoryTree/SearchResultsList', () => ({
    SearchResultsList: () => React.createElement('SearchResultsList'),
}));

vi.mock('@/sync/domains/session/resolveWorkspaceTargetForSession', () => ({
    resolveWorkspaceTargetForSession: () => ({
        workspaceCacheKey: 'server:m1:/repo',
        machineId: 'm1',
        rootPath: '/repo',
        serverId: 'server',
    }),
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

describe('SessionRepositoryTreeBrowserView (toolbar)', () => {
    afterEach(() => {
        workspaceRepositoryTreeRootLoading.current = false;
        latestWorkspaceRepositoryTreeListProps.current = null;
        standardCleanup();
    });

    async function renderRepositoryTreeBrowserView() {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        return renderScreen(<SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={vi.fn()} />);
    }

    it('shows the tree loading on the View menu while the root refreshes', async () => {
        workspaceRepositoryTreeRootLoading.current = true;
        const screen = await renderRepositoryTreeBrowserView();

        await act(async () => {
            latestWorkspaceRepositoryTreeListProps.current?.onRootLoadingChange?.(true);
        });

        expect(screen.findByTestId('repository-tree-refresh-loading')).toBeTruthy();
    });

    it('leaves Collapse all out of the View menu when no folders are expanded', async () => {
        const screen = await renderRepositoryTreeBrowserView();

        const menu = screen.findByTestId('repository-tree-view-menu');
        expect(menu?.props.items.map((item: any) => item.id)).toEqual([
            'repository-tree-toggle-details',
            'repository-tree-refresh',
        ]);
    });

    it('shows clear button when search is non-empty and refresh clears search cache + reloads tree', async () => {
        clearCacheSpy.mockClear();
        clearWorkspaceRepositoryDirectoryCacheSpy.mockClear();
        mountCount.current = 0;
        reloadCount.current = 0;

        const screen = await renderRepositoryTreeBrowserView();

        await act(async () => {});
        expect(mountCount.current).toBe(1);

        const input = screen.findByTestId('repository-tree-search');
        expect(input).toBeTruthy();
        await act(async () => {
            input?.props.onChangeText('src');
        });

        const clear = screen.findAllByTestId('repository-tree-clear-search');
        expect(clear.length).toBeGreaterThanOrEqual(1);

        await act(async () => {
            screen.pressByTestId('repository-tree-clear-search');
        });

        expect(screen.findByTestId('repository-tree-search')?.props.value).toBe('');

        await act(async () => {
            screen.findByTestId('repository-tree-view-menu')?.props.onSelect('repository-tree-refresh');
        });

        expect(clearWorkspaceRepositoryDirectoryCacheSpy).toHaveBeenCalledWith({ workspaceCacheKey: 'server:m1:/repo' });
        // Tree list remounts when switching between search-results and tree view.
        expect(mountCount.current).toBe(2);
        expect(reloadCount.current).toBe(3);
    });

    it('refreshes the repository tree when uploads succeed', async () => {
        clearCacheSpy.mockClear();
        clearRepositoryDirectoryCacheSpy.mockClear();
        clearWorkspaceRepositoryDirectoryCacheSpy.mockClear();
        latestTransferOptions = null;
        reloadCount.current = 0;

        const screen = await renderRepositoryTreeBrowserView();
        await act(async () => {});

        expect(typeof latestTransferOptions?.onAfterUploadSuccess).toBe('function');

        await act(async () => {
            latestTransferOptions.onAfterUploadSuccess();
        });

        expect(clearWorkspaceRepositoryDirectoryCacheSpy).toHaveBeenCalledWith({ workspaceCacheKey: 'server:m1:/repo' });
        expect(screen.findAllByTestId('workspace-repository-tree-list')).toHaveLength(1);
        expect(reloadCount.current).toBe(2);
    });
});
