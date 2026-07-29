import * as React from 'react';

import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const createWorktreeForMachinePathMock = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>());
const pruneWorktreesForMachinePathMock = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>(async () => ({ success: true })));
const removeWorktreeForMachinePathMock = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>(async () => ({ success: true })));
const readCachedBranchesForMachinePathMock = vi.hoisted(() => vi.fn<(input: unknown) => unknown>());
const fetchBranchesForMachinePathMock = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>());
const machineScmBranchCheckoutMock = vi.hoisted(() => vi.fn<(machineId: string, request: unknown, options?: unknown) => Promise<unknown>>(async () => ({ success: true })));
const machineScmBranchCreateMock = vi.hoisted(() => vi.fn<(machineId: string, request: unknown, options?: unknown) => Promise<unknown>>(async () => ({ success: true })));
const machineScmRemotePublishMock = vi.hoisted(() => vi.fn<(machineId: string, request: unknown) => Promise<unknown>>(async (_machineId, _request) => ({ success: true })));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: Record<string, unknown> & { children?: ((args: Record<string, never>) => React.ReactNode) | React.ReactNode; open?: boolean }) =>
        React.createElement('Popover', props, props.open && typeof props.children === 'function' ? props.children({}) : null),
}));

vi.mock('@/components/ui/navigation/SegmentedTabBar', () => ({
    SegmentedTabBar: (props: Record<string, unknown>) => React.createElement('SegmentedTabBar', props),
}));

vi.mock('@/components/ui/forms/dropdown/SelectableMenuResults', () => ({
    SelectableMenuResults: (props: Record<string, unknown>) => React.createElement('SelectableMenuResults', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSetting: () => 'always_bring',
    });
});

vi.mock('@/components/workspaces/scm/branches/SwitchBranchWithChangesDialog', () => ({
    showSwitchBranchWithChangesDialog: vi.fn(async () => 'bring_changes'),
}));

vi.mock('@/scm/repository/repoScmBranchService', () => ({
    repoScmBranchService: {
        readCachedBranchesForMachinePath: (input: unknown) => readCachedBranchesForMachinePathMock(input),
        fetchBranchesForMachinePath: (input: unknown) => fetchBranchesForMachinePathMock(input),
    },
}));

vi.mock('@/scm/repository/repoScmWorktreeService', () => ({
    repoScmWorktreeService: {
        createWorktreeForMachinePath: (input: unknown) => createWorktreeForMachinePathMock(input),
        pruneWorktreesForMachinePath: (input: unknown) => pruneWorktreesForMachinePathMock(input),
        removeWorktreeForMachinePath: (input: unknown) => removeWorktreeForMachinePathMock(input),
    },
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmBranchCheckout: (machineId: string, request: unknown, options?: unknown) => machineScmBranchCheckoutMock(machineId, request, options),
    machineScmBranchCreate: (machineId: string, request: unknown, options?: unknown) => machineScmBranchCreateMock(machineId, request, options),
    machineScmRemotePublish: (machineId: string, request: unknown) => machineScmRemotePublishMock(machineId, request),
}));

function buildSnapshot() {
    return {
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId: 'git',
            mode: '.git',
            worktrees: [
                { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                { path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
            ],
        },
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        capabilities: {
            readBranches: true,
            writeBranchCheckout: true,
            writeBranchCreate: true,
            worktreeCreate: true,
            writeRemotePublish: false,
        },
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
        fetchedAt: Date.now(),
        projectKey: 'p1',
        hasConflicts: false,
        entries: [],
        stashCount: 0,
    } as const;
}

async function openWorktreesTab(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const trigger = screen.tree.findByProps({ testID: 'scm-branch-menu-trigger' });
    await act(async () => {
        trigger.props.onPress();
    });
    const segmented = screen.tree.findByType('SegmentedTabBar' as never);
    await act(async () => {
        segmented.props.onSelectTab('worktrees');
    });
}

async function openBranchMenu(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const trigger = screen.tree.findByProps({ testID: 'scm-branch-menu-trigger' });
    await act(async () => {
        trigger.props.onPress();
    });
    await flushHookEffects({ cycles: 2, turns: 2 });
}

function flattenResultItems(results: { props: { categories?: Array<{ items: Array<{ id: string }> }> } }) {
    return (results.props.categories ?? []).flatMap((category) => category.items);
}

describe('WorkspaceSourceControlBranchMenu worktrees', () => {
    beforeEach(() => {
        createWorktreeForMachinePathMock.mockReset();
        pruneWorktreesForMachinePathMock.mockReset();
        removeWorktreeForMachinePathMock.mockReset();
        readCachedBranchesForMachinePathMock.mockReset();
        fetchBranchesForMachinePathMock.mockReset();
        machineScmBranchCheckoutMock.mockClear();
        machineScmBranchCreateMock.mockClear();
        machineScmRemotePublishMock.mockClear();
        readCachedBranchesForMachinePathMock.mockReturnValue([]);
        fetchBranchesForMachinePathMock.mockResolvedValue([]);
    });

    it('passes the workspace server scope to branch fetch requests', async () => {
        const { WorkspaceSourceControlBranchMenu } = await import('./WorkspaceSourceControlBranchMenu');

        const screen = await renderScreen(
            <WorkspaceSourceControlBranchMenu
                serverId="server-1"
                machineId="machine-1"
                rootPath="/repo"
                currentBranch="main"
                snapshot={buildSnapshot() as any}
                onRefreshSnapshot={vi.fn(async () => {})}
            />,
        );

        await openBranchMenu(screen);

        await vi.waitFor(() => {
            expect(fetchBranchesForMachinePathMock).toHaveBeenCalled();
        });
        expect(fetchBranchesForMachinePathMock).toHaveBeenCalledWith({
            serverId: 'server-1',
            machineId: 'machine-1',
            path: '/repo',
            includeRemotes: false,
        });
    });

    it('passes the workspace server scope to branch creation and checkout requests', async () => {
        readCachedBranchesForMachinePathMock.mockReturnValue([
            { name: 'main', type: 'local', isCurrent: true },
            { name: 'feature/auth', type: 'local', isCurrent: false },
        ]);
        fetchBranchesForMachinePathMock.mockResolvedValue([
            { name: 'main', type: 'local', isCurrent: true },
            { name: 'feature/auth', type: 'local', isCurrent: false },
        ]);
        const onRefreshSnapshot = vi.fn(async () => {});
        const { WorkspaceSourceControlBranchMenu } = await import('./WorkspaceSourceControlBranchMenu');

        const checkoutScreen = await renderScreen(
            <WorkspaceSourceControlBranchMenu
                serverId="server-1"
                machineId="machine-1"
                rootPath="/repo"
                currentBranch="main"
                snapshot={buildSnapshot() as any}
                onRefreshSnapshot={onRefreshSnapshot}
            />,
        );

        await openBranchMenu(checkoutScreen);

        const checkoutResults = checkoutScreen.tree.findByType('SelectableMenuResults' as never);
        const branchItem = flattenResultItems(checkoutResults as { props: { categories?: Array<{ items: Array<{ id: string }> }> } })
            .find((item) => item.id === 'branch:feature/auth');

        await act(async () => {
            checkoutResults.props.onPressItem(branchItem);
        });

        expect(machineScmBranchCheckoutMock).toHaveBeenCalledWith(
            'machine-1',
            {
                cwd: '/repo',
                name: 'feature/auth',
                strategy: 'bring_changes',
            },
            { serverId: 'server-1' },
        );

        const createScreen = await renderScreen(
            <WorkspaceSourceControlBranchMenu
                serverId="server-1"
                machineId="machine-1"
                rootPath="/repo"
                currentBranch="main"
                snapshot={buildSnapshot() as any}
                onRefreshSnapshot={onRefreshSnapshot}
            />,
        );

        await openBranchMenu(createScreen);
        const search = createScreen.tree.findByProps({ testID: 'workspace-scm-branch-popover-search' });
        await act(async () => {
            search.props.onChangeText('feature/new');
        });

        const createResults = createScreen.tree.findByType('SelectableMenuResults' as never);
        const createItem = flattenResultItems(createResults as { props: { categories?: Array<{ items: Array<{ id: string }> }> } })
            .find((item) => item.id === '__create__');

        await act(async () => {
            createResults.props.onPressItem(createItem);
        });

        expect(machineScmBranchCreateMock).toHaveBeenCalledWith(
            'machine-1',
            {
                cwd: '/repo',
                name: 'feature/new',
                checkout: true,
            },
            { serverId: 'server-1' },
        );
    });

    it('selects a sibling worktree through the project callback when chosen from the popover', async () => {
        const onSelectRootPath = vi.fn();
        const { WorkspaceSourceControlBranchMenu } = await import('./WorkspaceSourceControlBranchMenu');

        const screen = await renderScreen(
            <WorkspaceSourceControlBranchMenu
                machineId="machine-1"
                rootPath="/repo"
                currentBranch="main"
                snapshot={buildSnapshot() as any}
                onRefreshSnapshot={vi.fn(async () => {})}
                onSelectWorkspacePath={onSelectRootPath}
            />,
        );

        await openWorktreesTab(screen);

        const results = screen.tree.findByType('SelectableMenuResults' as never);
        const worktreeItem = results.props.categories
            .flatMap((category: { items: Array<{ id: string }> }) => category.items)
            .find((item: { id: string }) => item.id === 'worktree:open:/repo/.worktrees/feature-auth');

        await act(async () => {
            results.props.onPressItem(worktreeItem);
        });

        expect(onSelectRootPath).toHaveBeenCalledWith('/repo/.worktrees/feature-auth');
    });

    it('selects the newly created worktree after creating one from the current branch', async () => {
        createWorktreeForMachinePathMock.mockResolvedValue({
            success: true,
            worktreePath: '/repo/.worktrees/feature-auth',
            branchName: 'feature/auth',
        });

        const onSelectRootPath = vi.fn();
        const onRefreshSnapshot = vi.fn(async () => {});
        const { WorkspaceSourceControlBranchMenu } = await import('./WorkspaceSourceControlBranchMenu');

        const screen = await renderScreen(
            <WorkspaceSourceControlBranchMenu
                machineId="machine-1"
                rootPath="/repo"
                currentBranch="main"
                snapshot={buildSnapshot() as any}
                onRefreshSnapshot={onRefreshSnapshot}
                onSelectWorkspacePath={onSelectRootPath}
            />,
        );

        await openWorktreesTab(screen);

        const results = screen.tree.findByType('SelectableMenuResults' as never);
        const createItem = results.props.categories
            .flatMap((category: { items: Array<{ id: string }> }) => category.items)
            .find((item: { id: string }) => item.id === 'worktree:create-current-branch');

        await act(async () => {
            results.props.onPressItem(createItem);
        });

        expect(createWorktreeForMachinePathMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            path: '/repo',
            baseRef: null,
        });
        expect(onRefreshSnapshot).toHaveBeenCalled();
        expect(onSelectRootPath).toHaveBeenCalledWith('/repo/.worktrees/feature-auth');
    });

    it('passes the workspace server scope when creating a worktree from the current branch', async () => {
        createWorktreeForMachinePathMock.mockResolvedValue({
            success: true,
            worktreePath: '/repo/.worktrees/feature-auth',
            branchName: 'feature/auth',
        });

        const { WorkspaceSourceControlBranchMenu } = await import('./WorkspaceSourceControlBranchMenu');

        const screen = await renderScreen(
            <WorkspaceSourceControlBranchMenu
                serverId="server-1"
                machineId="machine-1"
                rootPath="/repo"
                currentBranch="main"
                snapshot={buildSnapshot() as any}
                onRefreshSnapshot={vi.fn(async () => {})}
                onSelectWorkspacePath={vi.fn()}
            />,
        );

        await openWorktreesTab(screen);

        const results = screen.tree.findByType('SelectableMenuResults' as never);
        const createItem = results.props.categories
            .flatMap((category: { items: Array<{ id: string }> }) => category.items)
            .find((item: { id: string }) => item.id === 'worktree:create-current-branch');

        await act(async () => {
            results.props.onPressItem(createItem);
        });

        expect(createWorktreeForMachinePathMock).toHaveBeenCalledWith({
            serverId: 'server-1',
            machineId: 'machine-1',
            path: '/repo',
            baseRef: null,
        });
    });

    it('passes the workspace server scope when pruning and removing worktrees', async () => {
        const { WorkspaceSourceControlBranchMenu } = await import('./WorkspaceSourceControlBranchMenu');

        const pruneScreen = await renderScreen(
            <WorkspaceSourceControlBranchMenu
                serverId="server-1"
                machineId="machine-1"
                rootPath="/repo"
                currentBranch="main"
                snapshot={buildSnapshot() as any}
                onRefreshSnapshot={vi.fn(async () => {})}
            />,
        );

        await openWorktreesTab(pruneScreen);
        const pruneResults = pruneScreen.tree.findByType('SelectableMenuResults' as never);
        const pruneItem = pruneResults.props.categories
            .flatMap((category: { items: Array<{ id: string }> }) => category.items)
            .find((item: { id: string }) => item.id === 'worktree:prune');

        await act(async () => {
            pruneResults.props.onPressItem(pruneItem);
        });

        expect(pruneWorktreesForMachinePathMock).toHaveBeenCalledWith({
            serverId: 'server-1',
            machineId: 'machine-1',
            path: '/repo',
        });

        const removeScreen = await renderScreen(
            <WorkspaceSourceControlBranchMenu
                serverId="server-1"
                machineId="machine-1"
                rootPath="/repo"
                currentBranch="main"
                snapshot={buildSnapshot() as any}
                onRefreshSnapshot={vi.fn(async () => {})}
            />,
        );

        await openWorktreesTab(removeScreen);
        const removeResults = removeScreen.tree.findByType('SelectableMenuResults' as never);
        const removeItem = removeResults.props.categories
            .flatMap((category: { items: Array<{ id: string }> }) => category.items)
            .find((item: { id: string }) => item.id === 'worktree:remove:/repo/.worktrees/feature-auth');

        await act(async () => {
            removeResults.props.onPressItem(removeItem);
        });

        expect(removeWorktreeForMachinePathMock).toHaveBeenCalledWith({
            serverId: 'server-1',
            machineId: 'machine-1',
            path: '/repo',
            worktreePath: '/repo/.worktrees/feature-auth',
        });
    });

    it('does not expose publish for an untracked branch when no remote is configured', async () => {
        const { WorkspaceSourceControlBranchMenu } = await import('./WorkspaceSourceControlBranchMenu');
        const snapshot = {
            ...buildSnapshot(),
            repo: {
                ...buildSnapshot().repo,
                remotes: [],
            },
            capabilities: {
                ...buildSnapshot().capabilities,
                writeRemotePublish: true,
            },
        };

        const screen = await renderScreen(
            <WorkspaceSourceControlBranchMenu
                machineId="machine-1"
                rootPath="/repo"
                currentBranch="main"
                snapshot={snapshot as any}
                onRefreshSnapshot={vi.fn(async () => {})}
            />,
        );

        await openBranchMenu(screen);

        const results = screen.tree.findByType('SelectableMenuResults' as never);
        const publishItem = flattenResultItems(results as { props: { categories?: Array<{ items: Array<{ id: string }> }> } })
            .find((item) => item.id === 'publish');

        expect(publishItem).toBeUndefined();
        expect(machineScmRemotePublishMock).not.toHaveBeenCalled();
    });

});
