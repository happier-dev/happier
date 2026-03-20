import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useSettingMock = vi.hoisted(() => vi.fn());
const usePublishBranchActionMock = vi.hoisted(() => vi.fn());
const routerPushMock = vi.hoisted(() => vi.fn());
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());
const createWorktreeForMachinePathMock = vi.hoisted(() => vi.fn());
const removeWorktreeForMachinePathMock = vi.hoisted(() => vi.fn());
const pruneWorktreesForMachinePathMock = vi.hoisted(() => vi.fn());
const modalConfirmMock = vi.hoisted(() => vi.fn());
const fetchBranchesForSessionMock = vi.hoisted(() => vi.fn());
const readCachedBranchesForSessionMock = vi.hoisted(() => vi.fn());
const invalidateBranchesForSessionMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
    Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#000',
                textSecondary: '#666',
            },
        },
    }),
    StyleSheet: {
        create: (input: any) => (typeof input === 'function'
            ? input({
                colors: {
                    text: '#000',
                    textSecondary: '#666',
                    divider: '#ddd',
                    surface: '#fff',
                    surfaceHigh: '#f6f6f6',
                    input: { placeholder: '#999' },
                    button: { primary: { background: '#000', tint: '#fff' } },
                },
            }, {})
            : input),
    },
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/ops', () => ({
    sessionScmBranchCheckout: vi.fn(),
    sessionScmBranchCreate: vi.fn(),
}));

vi.mock('@/scm/repository/repoScmBranchService', () => ({
    repoScmBranchService: {
        fetchBranchesForSession: (input: unknown) => fetchBranchesForSessionMock(input),
        readCachedBranchesForSession: (input: unknown) => readCachedBranchesForSessionMock(input),
        invalidateBranchesForSession: (input: unknown) => invalidateBranchesForSessionMock(input),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => useSettingMock(key),
}));

vi.mock('@/hooks/session/sourceControl/usePublishBranchAction', () => ({
    usePublishBranchAction: (...args: any[]) => usePublishBranchActionMock(...args),
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(),
        confirm: (...args: any[]) => modalConfirmMock(...args),
    },
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromMutationAndAwait: vi.fn(async () => {}),
    },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushMock }),
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: (sessionId: string) => readMachineTargetForSessionMock(sessionId),
}));

vi.mock('@/scm/repository/repoScmWorktreeService', () => ({
    repoScmWorktreeService: {
        createWorktreeForMachinePath: (input: unknown) => createWorktreeForMachinePathMock(input),
        removeWorktreeForMachinePath: (input: unknown) => removeWorktreeForMachinePathMock(input),
        pruneWorktreesForMachinePath: (input: unknown) => pruneWorktreesForMachinePathMock(input),
    },
}));

describe('SourceControlBranchMenu worktrees', () => {
    beforeEach(() => {
        fetchBranchesForSessionMock.mockReset();
        fetchBranchesForSessionMock.mockResolvedValue([]);
        readCachedBranchesForSessionMock.mockReset();
        readCachedBranchesForSessionMock.mockReturnValue([]);
        invalidateBranchesForSessionMock.mockReset();
        useSettingMock.mockImplementation(() => 'always_bring');
        usePublishBranchActionMock.mockReturnValue({
            canPublish: false,
            publishBusy: false,
            publishBranch: vi.fn(),
        });
        routerPushMock.mockReset();
        readMachineTargetForSessionMock.mockReset();
        createWorktreeForMachinePathMock.mockReset();
        removeWorktreeForMachinePathMock.mockReset();
        pruneWorktreesForMachinePathMock.mockReset();
        modalConfirmMock.mockReset();
        modalConfirmMock.mockResolvedValue(false);
    });

    it('surfaces sibling worktrees and opens a new session in the selected worktree', async () => {
        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SourceControlBranchMenu
                    sessionId="s1"
                    currentBranch="main"
                    snapshot={{
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
                        capabilities: { readBranches: true, writeBranchCheckout: true, worktreeCreate: true },
                        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
                        fetchedAt: Date.now(),
                        projectKey: 'p1',
                        hasConflicts: false,
                        entries: [],
                        stashCount: 0,
                    } as any}
                />
            );
        });

        let menu = tree.root.findByType('DropdownMenu' as any);
        await act(async () => {
            menu.props.onOpenChange(true);
            await Promise.resolve();
        });
        menu = tree.root.findByType('DropdownMenu' as any);

        expect(menu.props.items.some((item: any) => item.id === 'worktree:open:/repo/.worktrees/feature-auth')).toBe(true);

        await act(async () => {
            await menu.props.onSelect('worktree:open:/repo/.worktrees/feature-auth');
        });

        expect(routerPushMock).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                machineId: undefined,
                directory: '/repo/.worktrees/feature-auth',
            },
        });
    });

    it('creates a worktree session from the current branch through the shared repo worktree service', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo' });
        createWorktreeForMachinePathMock.mockResolvedValue({
            success: true,
            worktreePath: '/repo/.dev/worktree/feature-auth',
            branchName: 'feature-auth',
        });

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SourceControlBranchMenu
                    sessionId="s1"
                    currentBranch="main"
                    snapshot={{
                        repo: {
                            isRepo: true,
                            rootPath: '/repo',
                            backendId: 'git',
                            mode: '.git',
                            worktrees: [{ path: '/repo', branch: 'main', isCurrent: true, isMain: true }],
                        },
                        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                        capabilities: { readBranches: true, writeBranchCheckout: true, worktreeCreate: true },
                        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
                        fetchedAt: Date.now(),
                        projectKey: 'p1',
                        hasConflicts: false,
                        entries: [],
                        stashCount: 0,
                    } as any}
                />
            );
        });

        const menu = tree.root.findByType('DropdownMenu' as any);
        await act(async () => {
            await menu.props.onSelect('worktree:create-current-branch');
        });

        expect(createWorktreeForMachinePathMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            path: '/repo',
            baseRef: null,
        });
        expect(routerPushMock).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                machineId: 'machine-1',
                directory: '/repo/.dev/worktree/feature-auth',
            },
        });
    });

    it('preserves the current nested session path when creating a worktree from the current branch', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo/packages/app' });
        createWorktreeForMachinePathMock.mockResolvedValue({
            success: true,
            worktreePath: '/repo/.dev/worktree/feature-auth',
            branchName: 'feature-auth',
            sourceRootPath: '/repo',
        });

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SourceControlBranchMenu
                    sessionId="s1"
                    currentBranch="main"
                    snapshot={{
                        repo: {
                            isRepo: true,
                            rootPath: '/repo',
                            backendId: 'git',
                            mode: '.git',
                            worktrees: [{ path: '/repo', branch: 'main', isCurrent: true, isMain: true }],
                        },
                        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                        capabilities: { readBranches: true, writeBranchCheckout: true, worktreeCreate: true },
                        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
                        fetchedAt: Date.now(),
                        projectKey: 'p1',
                        hasConflicts: false,
                        entries: [],
                        stashCount: 0,
                    } as any}
                />
            );
        });

        const menu = tree.root.findByType('DropdownMenu' as any);
        await act(async () => {
            await menu.props.onSelect('worktree:create-current-branch');
        });

        expect(routerPushMock).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                machineId: 'machine-1',
                directory: '/repo/.dev/worktree/feature-auth/packages/app',
            },
        });
    });

    it('prunes worktrees through the shared repo worktree service', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo' });
        pruneWorktreesForMachinePathMock.mockResolvedValue({ success: true });

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SourceControlBranchMenu
                    sessionId="s1"
                    currentBranch="main"
                    snapshot={{
                        repo: {
                            isRepo: true,
                            rootPath: '/repo',
                            backendId: 'git',
                            mode: '.git',
                            worktrees: [{ path: '/repo', branch: 'main', isCurrent: true, isMain: true }],
                        },
                        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                        capabilities: { readBranches: true, writeBranchCheckout: true, worktreeCreate: true },
                        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
                        fetchedAt: Date.now(),
                        projectKey: 'p1',
                        hasConflicts: false,
                        entries: [],
                        stashCount: 0,
                    } as any}
                />
            );
        });

        const menu = tree.root.findByType('DropdownMenu' as any);
        await act(async () => {
            await menu.props.onSelect('worktree:prune');
        });

        expect(pruneWorktreesForMachinePathMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            path: '/repo',
        });
    });

    it('routes create-from-another-branch into the new-session worktree picker flow', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo' });

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SourceControlBranchMenu
                    sessionId="s1"
                    currentBranch="main"
                    snapshot={{
                        repo: {
                            isRepo: true,
                            rootPath: '/repo',
                            backendId: 'git',
                            mode: '.git',
                            worktrees: [{ path: '/repo', branch: 'main', isCurrent: true, isMain: true }],
                        },
                        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                        capabilities: { readBranches: true, writeBranchCheckout: true, worktreeCreate: true },
                        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
                        fetchedAt: Date.now(),
                        projectKey: 'p1',
                        hasConflicts: false,
                        entries: [],
                        stashCount: 0,
                    } as any}
                />
            );
        });

        const menu = tree.root.findByType('DropdownMenu' as any);
        await act(async () => {
            await menu.props.onSelect('worktree:create-from-another-branch');
        });

        expect(routerPushMock).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                machineId: 'machine-1',
                directory: '/repo',
                worktree: 'new',
            },
        });
    });

    it('removes a sibling worktree through the shared repo worktree service after confirmation', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo' });
        modalConfirmMock.mockResolvedValue(true);
        removeWorktreeForMachinePathMock.mockResolvedValue({ success: true });

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SourceControlBranchMenu
                    sessionId="s1"
                    currentBranch="main"
                    snapshot={{
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
                        capabilities: { readBranches: true, writeBranchCheckout: true, worktreeCreate: true },
                        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
                        fetchedAt: Date.now(),
                        projectKey: 'p1',
                        hasConflicts: false,
                        entries: [],
                        stashCount: 0,
                    } as any}
                />
            );
        });

        let menu = tree.root.findByType('DropdownMenu' as any);
        await act(async () => {
            menu.props.onOpenChange(true);
            await Promise.resolve();
        });
        menu = tree.root.findByType('DropdownMenu' as any);

        expect(menu.props.items.some((item: any) => item.id === 'worktree:remove:/repo/.worktrees/feature-auth')).toBe(true);

        await act(async () => {
            await menu.props.onSelect('worktree:remove:/repo/.worktrees/feature-auth');
        });

        expect(removeWorktreeForMachinePathMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            path: '/repo',
            worktreePath: '/repo/.worktrees/feature-auth',
        });
    });
});
