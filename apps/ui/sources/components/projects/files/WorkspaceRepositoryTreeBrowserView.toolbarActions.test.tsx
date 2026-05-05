import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createModalModuleMock, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const storageSpies = vi.hoisted(() => ({
    setWorkspaceRepositoryTreeExpandedPaths: vi.fn(),
}));

const promptSpy = vi.fn(async (..._args: any[]) => null as any);
const alertSpy = vi.fn((..._args: any[]) => {});
const workspaceWriteFileSpy = vi.fn(async (..._args: any[]) => ({ success: true } as any));
const workspaceCreateDirectorySpy = vi.fn(async (..._args: any[]) => ({ success: true } as any));
const clearWorkspaceFileSearchCacheSpy = vi.fn();
const clearWorkspaceRepositoryDirectoryEntriesSpy = vi.fn();
const startUploadsSpy = vi.fn(async (..._args: any[]) => ({ ok: true } as const));
let latestTransferOptions: any = null;

const safePathSpy = vi.fn((value: string) => value === 'src/new-file.ts' || value === 'src/new-folder');
const onOpenFileSpy = vi.fn();
const onOpenFilePinnedSpy = vi.fn();

const latestWorkspaceRepositoryTreeListProps = vi.hoisted(() => ({
    current: null as any,
    rootLoading: false,
}));

const workspaceScmControllerState = vi.hoisted(() => ({
    snapshot: {
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
        entries: [
            {
                path: 'src/index.ts',
                kind: 'modified',
                previousPath: null,
                hasIncludedDelta: false,
                hasPendingDelta: true,
                stats: { includedAdded: 1, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0, isBinary: false },
            },
        ],
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false,
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
        capabilities: {} as any,
        fetchedAt: 1,
    } as any,
    refresh: vi.fn(async () => {}),
}));

const transferHookState = vi.hoisted(() => ({
    uploadState: { status: 'idle' } as any,
    downloadState: { status: 'idle' } as any,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
        View: (props: any) => React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/modal', () => {
    const modalModuleMock = createModalModuleMock();
    modalModuleMock.spies.prompt.mockImplementation((...args: any[]) => promptSpy(...args));
    modalModuleMock.spies.alert.mockImplementation((...args: any[]) => alertSpy(...args));
    return modalModuleMock.module;
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        storage: {
            getState: () => ({
                setWorkspaceRepositoryTreeExpandedPaths: storageSpies.setWorkspaceRepositoryTreeExpandedPaths,
            }),
        } as any,
        useWorkspaceRepositoryTreeExpandedPaths: () => ['src'],
        useMachine: () => ({ id: 'm1', active: true, activeAt: Date.now() }) as any,
    });
});

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesSnapshotForServerId: () => ({
        status: 'ready',
        features: {
            features: {
                machines: {
                    enabled: true,
                    transfer: { enabled: true },
                },
            },
            capabilities: {},
        },
    }),
}));

vi.mock('@/hooks/workspaces/scm/useWorkspaceScmSnapshotController', () => ({
    useWorkspaceScmSnapshotController: () => ({
        snapshot: workspaceScmControllerState.snapshot,
        loading: false,
        error: null,
        refresh: workspaceScmControllerState.refresh,
    }),
}));

vi.mock('@/sync/ops/workspaceFileSystem', () => ({
    workspaceWriteFile: (...args: any[]) => workspaceWriteFileSpy(...args),
    workspaceCreateDirectory: (...args: any[]) => workspaceCreateDirectorySpy(...args),
}));

vi.mock('@/sync/domains/workspaces/files/workspaceFileSearch', () => ({
    workspaceFileSearchCache: {
        clearCache: (workspaceCacheKey: string) => clearWorkspaceFileSearchCacheSpy(workspaceCacheKey),
    },
    searchWorkspaceFiles: vi.fn(async () => []),
}));

vi.mock('@/sync/domains/workspaces/files/workspaceRepositoryDirectory', () => ({
    clearCachedWorkspaceRepositoryDirectoryEntries: (input: { workspaceCacheKey: string }) =>
        clearWorkspaceRepositoryDirectoryEntriesSpy(input),
}));

vi.mock('@/hooks/workspaces/transfers/useWorkspaceFileTransfers', () => ({
    useWorkspaceFileTransfers: (input: any) => {
        latestTransferOptions = input;
        return {
            uploadState: transferHookState.uploadState,
            downloadState: transferHookState.downloadState,
            startUploads: (...args: any[]) => startUploadsSpy(...args),
            cancelUploads: vi.fn(),
            startDownload: vi.fn(async () => ({ ok: true })),
            cancelDownload: vi.fn(),
        };
    },
}));

vi.mock('@/utils/path/isSafeWorkspaceRelativePath', () => ({
    isSafeWorkspaceRelativePath: (value: string) => safePathSpy(value),
}));

vi.mock('@/components/workspaces/files/repositoryTree/computeExpandedPathsForReveal', () => ({
    computeExpandedPathsForReveal: ({ expandedPaths }: any) => expandedPaths,
}));

vi.mock('./WorkspaceRepositoryTreeList', () => ({
    WorkspaceRepositoryTreeList: (props: any) => {
        latestWorkspaceRepositoryTreeListProps.current = props;
        React.useEffect(() => {
            props?.onRootLoadingChange?.(latestWorkspaceRepositoryTreeListProps.rootLoading);
        }, [props]);
        return React.createElement('View', { testID: 'workspace-repository-tree-list-stub' });
    },
}));

vi.mock('@/components/workspaces/files/repositoryTree/SearchResultsList', () => ({
    SearchResultsList: () => React.createElement('SearchResultsList'),
}));

vi.mock('@/components/workspaces/files/repositoryTree/ChangedFilesTreeList', () => ({
    ChangedFilesTreeList: () => React.createElement('View', { testID: 'changed-files-tree-list-stub' }),
}));

describe('WorkspaceRepositoryTreeBrowserView (toolbar actions)', () => {
    beforeEach(() => {
        promptSpy.mockReset();
        alertSpy.mockClear();
        workspaceWriteFileSpy.mockClear();
        workspaceCreateDirectorySpy.mockClear();
        safePathSpy.mockClear();
        safePathSpy.mockImplementation((value: string) => value === 'src/new-file.ts' || value === 'src/new-folder');
        onOpenFileSpy.mockClear();
        onOpenFilePinnedSpy.mockClear();
        storageSpies.setWorkspaceRepositoryTreeExpandedPaths.mockClear();
        clearWorkspaceFileSearchCacheSpy.mockClear();
        clearWorkspaceRepositoryDirectoryEntriesSpy.mockClear();
        startUploadsSpy.mockClear();
        latestTransferOptions = null;
        latestWorkspaceRepositoryTreeListProps.current = null;
        latestWorkspaceRepositoryTreeListProps.rootLoading = false;
        transferHookState.uploadState = { status: 'idle' } as any;
        transferHookState.downloadState = { status: 'idle' } as any;
    });

    afterEach(() => {
        standardCleanup();
    });

    async function settle(): Promise<void> {
        await flushHookEffects({ cycles: 2, turns: 2 });
    }

    async function renderView(overrides: Partial<React.ComponentProps<typeof import('./WorkspaceRepositoryTreeBrowserView').WorkspaceRepositoryTreeBrowserView>> = {}) {
        const { WorkspaceRepositoryTreeBrowserView } = await import('./WorkspaceRepositoryTreeBrowserView');
        return await renderScreen(
            <WorkspaceRepositoryTreeBrowserView
                workspaceCacheKey="server:m1:/repo"
                serverId="server"
                machineId="m1"
                rootPath="/repo"
                onOpenFile={onOpenFileSpy}
                onOpenFilePinned={onOpenFilePinnedSpy}
                {...overrides}
            />,
        );
    }

    it('toggles between full tree and changed-only tree', async () => {
        const screen = await renderView();

        expect(screen.findAllByTestId('workspace-repository-tree-list-stub')).toHaveLength(1);
        expect(screen.findAllByTestId('changed-files-tree-list-stub')).toHaveLength(0);
        expect(screen.findAllByTestId('workspace-repository-tree-filter-changed').length).toBeGreaterThanOrEqual(1);

        await act(async () => {
            screen.pressByTestId('workspace-repository-tree-filter-changed');
            await settle();
        });

        expect(screen.findAllByTestId('workspace-repository-tree-list-stub')).toHaveLength(0);
        expect(screen.findAllByTestId('changed-files-tree-list-stub')).toHaveLength(1);
    });

    it('keeps refresh visible and uses it as the tree refresh loading indicator', async () => {
        latestWorkspaceRepositoryTreeListProps.rootLoading = true;
        const screen = await renderView();

        expect(latestWorkspaceRepositoryTreeListProps.current).toBeTruthy();
        expect(typeof latestWorkspaceRepositoryTreeListProps.current?.onRootLoadingChange).toBe('function');
        await act(async () => {
            latestWorkspaceRepositoryTreeListProps.current?.onRootLoadingChange?.(true);
            await settle();
        });

        const toolbar = screen.findByTestId('repository-tree-toolbar');
        expect(toolbar).toBeTruthy();
        await act(async () => {
            toolbar?.props.onLayout?.({ nativeEvent: { layout: { width: 320, height: 42, x: 0, y: 0 } } });
        });

        expect(screen.findAllByTestId('workspace-repository-tree-refresh').length).toBeGreaterThanOrEqual(1);
        const overflowMenu = screen.findAllByType('ItemRowActions' as any)[0] ?? null;
        expect(overflowMenu?.props.actions.some((item: any) => item.id === 'workspace-repository-tree-refresh') ?? false).toBe(false);
        expect(screen.findByTestId('workspace-repository-tree-refresh-loading')).toBeTruthy();
    });

    it('hides collapse-all when no folders are expanded', async () => {
        const screen = await renderView({
            expandedPaths: [],
            onExpandedPathsChange: vi.fn(),
        });

        expect(screen.findAllByTestId('workspace-repository-tree-collapse-all')).toHaveLength(0);
        const overflowMenu = screen.findAllByType('ItemRowActions' as any)[0] ?? null;
        expect(overflowMenu?.props.actions.some((item: any) => item.id === 'workspace-repository-tree-collapse-all') ?? false).toBe(false);
    });

    it('creates a file under the workspace root via workspaceWriteFile', async () => {
        promptSpy.mockResolvedValueOnce('src/new-file.ts');

        const screen = await renderView();

        await act(async () => {
            screen.pressByTestId('workspace-repository-tree-create-file');
            await settle();
        });

        expect(workspaceWriteFileSpy).toHaveBeenCalledWith(
            { machineId: 'm1', rootPath: '/repo', serverId: 'server' },
            'src/new-file.ts',
            '',
            null,
        );
        expect(onOpenFilePinnedSpy).toHaveBeenCalledWith('src/new-file.ts');
    });

    it('creates a directory under the workspace root via workspaceCreateDirectory', async () => {
        promptSpy.mockResolvedValueOnce('src/new-folder');

        const screen = await renderView();

        await act(async () => {
            screen.pressByTestId('workspace-repository-tree-create-folder');
            await settle();
        });

        expect(workspaceCreateDirectorySpy).toHaveBeenCalledWith(
            { machineId: 'm1', rootPath: '/repo', serverId: 'server' },
            'src/new-folder',
        );
    });

    it('wires workspace uploads through the canonical workspace transfer hook and refreshes after upload success', async () => {
        const screen = await renderView();

        expect(screen.findAllByTestId('workspace-repository-tree-upload').length).toBeGreaterThanOrEqual(1);
        expect(latestTransferOptions?.workspaceScope).toEqual({
            serverId: 'server',
            machineId: 'm1',
            rootPath: '/repo',
        });
        expect(typeof latestTransferOptions?.onAfterUploadSuccess).toBe('function');

        await act(async () => {
            latestTransferOptions.onAfterUploadSuccess();
            await settle();
        });

        expect(clearWorkspaceFileSearchCacheSpy).toHaveBeenCalledWith('server:m1:/repo');
        expect(clearWorkspaceRepositoryDirectoryEntriesSpy).toHaveBeenCalledWith({ workspaceCacheKey: 'server:m1:/repo' });
        expect(workspaceScmControllerState.refresh).toHaveBeenCalled();
    });

    it('renders the shared transfer status bar when a workspace upload is in progress', async () => {
        transferHookState.uploadState = {
            status: 'uploading',
            totalFiles: 2,
            completedFiles: 1,
            uploadedBytes: 50,
            totalBytes: 100,
        } as any;

        const screen = await renderView();

        expect(screen.findByTestId('repository-tree-transfer-status')).toBeTruthy();
        expect(screen.findByTestId('repository-tree-upload-status')).toBeTruthy();
    });
});
