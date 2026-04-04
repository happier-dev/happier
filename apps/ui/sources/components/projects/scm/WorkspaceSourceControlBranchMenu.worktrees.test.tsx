import * as React from 'react';

import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const createWorktreeForMachinePathMock = vi.hoisted(() => vi.fn());
const readCachedBranchesForMachinePathMock = vi.hoisted(() => vi.fn());
const fetchBranchesForMachinePathMock = vi.hoisted(() => vi.fn());

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

vi.mock('@/scm/repository/useRepoScmBranchList', () => ({
    useRepoScmBranchList: () => ({
        branches: [],
        phase: 'ready',
        refresh: vi.fn(async () => {}),
    }),
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
        pruneWorktreesForMachinePath: vi.fn(async () => ({ success: true })),
        removeWorktreeForMachinePath: vi.fn(async () => ({ success: true })),
    },
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmBranchCheckout: vi.fn(async () => ({ success: true })),
    machineScmBranchCreate: vi.fn(async () => ({ success: true })),
    machineScmRemotePublish: vi.fn(async () => ({ success: true })),
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

describe('WorkspaceSourceControlBranchMenu worktrees', () => {
    beforeEach(() => {
        createWorktreeForMachinePathMock.mockReset();
        readCachedBranchesForMachinePathMock.mockReset();
        fetchBranchesForMachinePathMock.mockReset();
        readCachedBranchesForMachinePathMock.mockReturnValue([]);
        fetchBranchesForMachinePathMock.mockResolvedValue([]);
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
});
