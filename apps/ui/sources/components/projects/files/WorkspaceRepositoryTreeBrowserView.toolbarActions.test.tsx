import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCapturingLegendListMock, createModalModuleMock, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const storageSpies = vi.hoisted(() => ({
    setWorkspaceRepositoryTreeExpandedPaths: vi.fn(),
}));

const promptSpy = vi.fn(async (..._args: any[]) => null as any);
const alertSpy = vi.fn((..._args: any[]) => {});
const workspaceWriteFileSpy = vi.fn(async (..._args: any[]) => ({ success: true } as any));
const workspaceCreateDirectorySpy = vi.fn(async (..._args: any[]) => ({ success: true } as any));
const machineWorkspaceFileListSpy = vi.fn(async (_machineId: string, _input: unknown, _options: unknown) => ({
    ok: true as const, paths: ['src/needle.ts'], truncated: false,
}));
const clearWorkspaceRepositoryDirectoryEntriesSpy = vi.fn();
const startUploadsSpy = vi.fn(async (..._args: any[]) => ({ ok: true } as const));
let latestTransferOptions: any = null;

const safePathSpy = vi.fn((value: string) => value === 'src/new-file.ts' || value === 'src/new-folder');
const onOpenFileSpy = vi.fn();
const onOpenFilePinnedSpy = vi.fn();
let serverId = '';
let secondServerId = '';

// Secure credential storage is the boundary; the real query owner resolves its Home binding.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: { getCredentialsForServerUrl: async () => ({
            token: 'header.eyJzdWIiOiJhY2NvdW50In0=.signature',
        }) },
    });
});

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
const machineState = vi.hoisted(() => ({
    current: { id: 'm1', active: true, activeAt: Date.now() } as any,
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
        useMachine: () => machineState.current,
        useServerScopedMachine: () => machineState.current,
    });
});

vi.mock('@/sync/runtime/nativeIrohTunnels/machineTransferLifecycle', () => ({
    isIrohMachineTransferLifecycleAvailable: () => false,
    probeIrohMachineTransferLifecycleAvailability: async () => false,
    subscribeIrohMachineTransferLifecycleAvailability: () => () => {},
}));

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

vi.mock('@/sync/ops/machineWorkspaceFileList', () => ({
    machineWorkspaceFileList: (machineId: string, input: unknown, options: unknown) => machineWorkspaceFileListSpy(machineId, input, options),
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

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => {
        const trigger = typeof props.trigger === 'function'
            ? props.trigger({ toggle: vi.fn(), openMenu: vi.fn(), closeMenu: vi.fn(), open: Boolean(props.open), selectedItem: null })
            : props.trigger;
        return React.createElement('DropdownMenu', props, trigger);
    },
}));

// Virtualization is a third-party boundary; keep the result rows and query owner real.
vi.mock('@legendapp/list/react-native', () => createCapturingLegendListMock({ renderItems: true }).module);

describe('WorkspaceRepositoryTreeBrowserView (toolbar actions)', () => {
    beforeEach(async () => {
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        serverId = (await upsertServerProfile({ serverUrl: 'https://toolbar-server.example.test' })).id;
        secondServerId = (await upsertServerProfile({ serverUrl: 'https://toolbar-server-b.example.test' })).id;
        const { workspaceFileSearchCache } = await import('@/sync/domains/workspaces/files/workspaceFileSearch');
        workspaceFileSearchCache.clearAll();
        promptSpy.mockReset();
        alertSpy.mockClear();
        workspaceWriteFileSpy.mockClear();
        workspaceCreateDirectorySpy.mockClear();
        safePathSpy.mockClear();
        safePathSpy.mockImplementation((value: string) => value === 'src/new-file.ts' || value === 'src/new-folder');
        onOpenFileSpy.mockClear();
        onOpenFilePinnedSpy.mockClear();
        storageSpies.setWorkspaceRepositoryTreeExpandedPaths.mockClear();
        machineWorkspaceFileListSpy.mockClear();
        clearWorkspaceRepositoryDirectoryEntriesSpy.mockClear();
        startUploadsSpy.mockClear();
        latestTransferOptions = null;
        latestWorkspaceRepositoryTreeListProps.current = null;
        latestWorkspaceRepositoryTreeListProps.rootLoading = false;
        transferHookState.uploadState = { status: 'idle' } as any;
        transferHookState.downloadState = { status: 'idle' } as any;
        machineState.current = { id: 'm1', active: true, activeAt: Date.now() } as any;
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
                scope={{ serverId, machineId: 'm1', rootPath: '/repo' }}
                onOpenFile={onOpenFileSpy}
                onOpenFilePinned={onOpenFilePinnedSpy}
                {...overrides}
            />,
        );
    }

    /**
     * A workspace is addressed by `{ serverId, machineId, rootPath }` — all three, because a
     * machine id is only unique within the server that reaches it.
     *
     * This view is where that came apart: it passed the server-scoped cache key while calling
     * the search WITHOUT the server, so the index was read through whichever server
     * `machineRpcWithServerScope` falls back to and then stored under the correctly-scoped
     * key, where the composer's own (correctly addressed) search read it back. The view now
     * forwards the one `scope` it was given, and the owner derives the key from it — so this
     * asserts the whole address reaches the search, on the wire rather than on rendered rows,
     * because rows look identical either way. That is what made the omission survive.
     */
    it('addresses the file search at the server the workspace is on', async () => {
        const screen = await renderView({
            scope: { serverId: secondServerId, machineId: 'm1', rootPath: '/repo' },
            searchQuery: 'needle',
        });

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 250));
            await settle();
        });

        expect(machineWorkspaceFileListSpy).toHaveBeenCalledTimes(1);
        expect(machineWorkspaceFileListSpy.mock.calls[0]).toEqual([
            'm1', expect.objectContaining({ rootPath: '/repo' }),
            expect.objectContaining({ serverId: secondServerId, signal: expect.any(AbortSignal) }),
        ]);
        expect(screen.getTextContent()).toContain('needle.ts');
        expect(screen).toBeTruthy();
    });

    /**
     * Contracting the address into one `scope` OBJECT moved the search effect's dependency from
     * three primitive strings to an object identity. Several hosts build that prop inline, and
     * `useSessionWorkspaceTarget` rebuilds its result whenever the machine/session collections
     * change identity — so an unstabilized scope re-runs the search on EVERY render.
     *
     * That is not theoretical: it was reproduced here as an unbounded render loop that
     * exhausted the test runner's heap. The view therefore memoizes the scope on its three
     * FIELDS, and this pins it: a host that hands over a brand-new (but equal) literal on every
     * render must still produce exactly one search.
     */
    it('does not re-search when a host passes a new but equal scope object on every render', async () => {
        const { WorkspaceRepositoryTreeBrowserView } = await import('./WorkspaceRepositoryTreeBrowserView');
        let bumpHostState: () => void = () => {};

        function UnstableScopeHost() {
            const [, setTick] = React.useState(0);
            bumpHostState = () => setTick((n) => n + 1);
            return (
                <WorkspaceRepositoryTreeBrowserView
                    // Deliberately a fresh object literal on every render.
                    scope={{ serverId: secondServerId, machineId: 'm1', rootPath: '/repo' }}
                    searchQuery="needle"
                    onOpenFile={onOpenFileSpy}
                    onOpenFilePinned={onOpenFilePinnedSpy}
                />
            );
        }

        await renderScreen(<UnstableScopeHost />);
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 250));
            await settle();
        });
        expect(machineWorkspaceFileListSpy).toHaveBeenCalledTimes(1);

        // Three more host renders, three more fresh-but-equal scope literals.
        for (let i = 0; i < 3; i++) {
            await act(async () => {
                bumpHostState();
                await settle();
            });
        }
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 250));
            await settle();
        });

        expect(machineWorkspaceFileListSpy).toHaveBeenCalledTimes(1);
    });

    const menu = (screen: Awaited<ReturnType<typeof renderView>>, testID: string) => screen.findByTestId(testID);
    const menuItem = (screen: Awaited<ReturnType<typeof renderView>>, testID: string, id: string) =>
        menu(screen, testID)?.props.items.find((item: any) => item.id === id);

    it('prunes the same tree to the changed files in place, and the chip clears it', async () => {
        const screen = await renderView();
        expect(latestWorkspaceRepositoryTreeListProps.current?.changedOnly).toBe(false);

        await act(async () => {
            screen.pressByTestId('workspace-repository-tree-filter-changed');
            await settle();
        });

        expect(screen.findAllByTestId('workspace-repository-tree-list-stub')).toHaveLength(1);
        expect(latestWorkspaceRepositoryTreeListProps.current?.changedOnly).toBe(true);
        await act(async () => {
            screen.pressByTestId('workspace-repository-tree-changed-only-chip');
            await settle();
        });
        expect(latestWorkspaceRepositoryTreeListProps.current?.changedOnly).toBe(false);
    });

    it('shows the tree loading on the View menu while the root refreshes', async () => {
        latestWorkspaceRepositoryTreeListProps.rootLoading = true;
        const screen = await renderView();
        await act(async () => {
            latestWorkspaceRepositoryTreeListProps.current?.onRootLoadingChange?.(true);
            await settle();
        });
        expect(screen.findByTestId('workspace-repository-tree-refresh-loading')).toBeTruthy();
    });

    it('leaves Collapse all out of the View menu when no folders are expanded', async () => {
        const screen = await renderView({
            expandedPaths: [],
            onExpandedPathsChange: vi.fn(),
        });

        expect(menu(screen, 'workspace-repository-tree-view-menu')?.props.items.map((item: any) => item.id)).toEqual([
            'workspace-repository-tree-toggle-details',
            'workspace-repository-tree-refresh',
        ]);
    });

    it('creates a file under the workspace root via workspaceWriteFile', async () => {
        promptSpy.mockResolvedValueOnce('src/new-file.ts');

        const screen = await renderView();

        await act(async () => {
            menu(screen, 'repository-tree-create-menu')?.props.onSelect('repository-tree-create-file');
            await settle();
        });

        expect(workspaceWriteFileSpy).toHaveBeenCalledWith(
            { machineId: 'm1', rootPath: '/repo', serverId },
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
            menu(screen, 'repository-tree-create-menu')?.props.onSelect('repository-tree-create-folder');
            await settle();
        });

        expect(workspaceCreateDirectorySpy).toHaveBeenCalledWith(
            { machineId: 'm1', rootPath: '/repo', serverId },
            'src/new-folder',
        );
    });

    it('wires workspace uploads through the canonical workspace transfer hook and refreshes after upload success', async () => {
        const screen = await renderView();
        const { searchWorkspaceFiles } = await import('@/sync/domains/workspaces/files/workspaceFileSearch');
        const search = { scope: { serverId, machineId: 'm1', rootPath: '/repo' }, query: 'needle' };
        await searchWorkspaceFiles(search);
        expect(machineWorkspaceFileListSpy).toHaveBeenCalledTimes(1);

        expect(menuItem(screen, 'repository-tree-create-menu', 'repository-tree-upload-files')).toBeTruthy();
        expect(latestTransferOptions?.workspaceScope).toEqual({
            serverId,
            machineId: 'm1',
            rootPath: '/repo',
        });
        expect(typeof latestTransferOptions?.onAfterUploadSuccess).toBe('function');

        await act(async () => {
            latestTransferOptions.onAfterUploadSuccess();
            await settle();
        });

        // The next read must reach transport again after the upload invalidates this workspace.
        await searchWorkspaceFiles(search);
        expect(machineWorkspaceFileListSpy).toHaveBeenCalledTimes(2);
        expect(clearWorkspaceRepositoryDirectoryEntriesSpy).toHaveBeenCalledWith({ workspaceCacheKey: `${serverId}:m1:/repo` });
        expect(workspaceScmControllerState.refresh).toHaveBeenCalled();
    });

    it('keeps transfer actions unavailable for a daemon without a current transfer declaration', async () => {
        machineState.current = {
            id: 'm1',
            active: true,
            activeAt: Date.now(),
            daemonState: { status: 'running' },
        } as any;

        const screen = await renderView();

        expect(menuItem(screen, 'repository-tree-create-menu', 'repository-tree-upload-files')?.disabled).toBe(true);
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
