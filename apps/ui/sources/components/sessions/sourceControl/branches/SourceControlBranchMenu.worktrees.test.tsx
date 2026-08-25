import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    installSourceControlBranchMenuCommonModuleMocks,
    listSourceControlBranchMenuItemIds,
    openSourceControlBranchMenu,
    resetSourceControlBranchMenuCommonModuleMockState,
    selectSourceControlBranchMenuItem,
    sourceControlBranchMenuModuleState,
} from './sourceControlBranchMenuTestHelpers';

installSourceControlBranchMenuCommonModuleMocks();

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('SourceControlBranchMenu worktrees', () => {
    beforeEach(() => {
        resetSourceControlBranchMenuCommonModuleMockState();
        sourceControlBranchMenuModuleState.useSettingMock.mockImplementation(() => 'always_bring');
        sourceControlBranchMenuModuleState.modalConfirmSpy.mockResolvedValue(false);
    });

    it('surfaces sibling worktrees and opens a new session in the selected worktree', async () => {
        sourceControlBranchMenuModuleState.preferredServerIdForSession = 'server-a';
        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        const screen = await renderScreen(<SourceControlBranchMenu
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
                />);

        await openSourceControlBranchMenu(screen);
        expect(listSourceControlBranchMenuItemIds(screen)).not.toContain('worktree:open:/repo/.worktrees/feature-auth');
        const segmented = screen.findByType('SegmentedTabBar' as any);
        await act(async () => {
            segmented.props.onSelectTab('worktrees');
        });
        await selectSourceControlBranchMenuItem(screen, 'worktree:open:/repo/.worktrees/feature-auth');

        expect(sourceControlBranchMenuModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: expect.any(String),
                machineId: undefined,
                directory: '/repo/.worktrees/feature-auth',
                spawnServerId: 'server-a',
            },
        });
    });

    it('creates a worktree session from the current branch through the shared repo worktree service', async () => {
        sourceControlBranchMenuModuleState.preferredServerIdForSession = 'server-a';
        sourceControlBranchMenuModuleState.readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo' });
        sourceControlBranchMenuModuleState.createWorktreeForMachinePathMock.mockResolvedValue({
            success: true,
            worktreePath: '/repo/.dev/worktree/feature-auth',
            branchName: 'feature-auth',
        });

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        const screen = await renderScreen(<SourceControlBranchMenu
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
                />);

        await openSourceControlBranchMenu(screen);
        const segmented = screen.findByType('SegmentedTabBar' as any);
        await act(async () => {
            segmented.props.onSelectTab('worktrees');
        });
        await selectSourceControlBranchMenuItem(screen, 'worktree:create-current-branch');

        expect(sourceControlBranchMenuModuleState.createWorktreeForMachinePathMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            path: '/repo',
            baseRef: null,
            serverId: 'server-a',
        });
        expect(sourceControlBranchMenuModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: expect.any(String),
                machineId: 'machine-1',
                directory: '/repo/.dev/worktree/feature-auth',
                spawnServerId: 'server-a',
            },
        });
    });

    it('preserves the current nested session path when creating a worktree from the current branch', async () => {
        sourceControlBranchMenuModuleState.readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo/packages/app' });
        sourceControlBranchMenuModuleState.createWorktreeForMachinePathMock.mockResolvedValue({
            success: true,
            worktreePath: '/repo/.dev/worktree/feature-auth',
            branchName: 'feature-auth',
            sourceRootPath: '/repo',
        });

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        const screen = await renderScreen(<SourceControlBranchMenu
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
                />);

        await openSourceControlBranchMenu(screen);
        const segmented = screen.findByType('SegmentedTabBar' as any);
        await act(async () => {
            segmented.props.onSelectTab('worktrees');
        });
        await selectSourceControlBranchMenuItem(screen, 'worktree:create-current-branch');

        expect(sourceControlBranchMenuModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: expect.any(String),
                machineId: 'machine-1',
                directory: '/repo/.dev/worktree/feature-auth/packages/app',
            },
        });
    });

    it('prunes worktrees through the shared repo worktree service', async () => {
        sourceControlBranchMenuModuleState.preferredServerIdForSession = 'server-a';
        sourceControlBranchMenuModuleState.readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo' });
        sourceControlBranchMenuModuleState.pruneWorktreesForMachinePathMock.mockResolvedValue({ success: true });

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        const screen = await renderScreen(<SourceControlBranchMenu
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
                />);

        await openSourceControlBranchMenu(screen);
        const segmented = screen.findByType('SegmentedTabBar' as any);
        await act(async () => {
            segmented.props.onSelectTab('worktrees');
        });
        await selectSourceControlBranchMenuItem(screen, 'worktree:prune');

        expect(sourceControlBranchMenuModuleState.pruneWorktreesForMachinePathMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            path: '/repo',
            serverId: 'server-a',
        });
    });

    it('routes create-from-another-branch into the new-session worktree picker flow', async () => {
        sourceControlBranchMenuModuleState.preferredServerIdForSession = 'server-a';
        sourceControlBranchMenuModuleState.readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo' });

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        const screen = await renderScreen(<SourceControlBranchMenu
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
                />);

        await openSourceControlBranchMenu(screen);
        const segmented = screen.findByType('SegmentedTabBar' as any);
        await act(async () => {
            segmented.props.onSelectTab('worktrees');
        });
        await selectSourceControlBranchMenuItem(screen, 'worktree:create-from-another-branch');

        expect(sourceControlBranchMenuModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: expect.any(String),
                machineId: 'machine-1',
                directory: '/repo',
                worktree: 'new',
                spawnServerId: 'server-a',
            },
        });
    });

    it('segments branches and worktrees inside the branch popover', async () => {
        sourceControlBranchMenuModuleState.useSettingMock.mockImplementation(() => 'always_bring');
        sourceControlBranchMenuModuleState.fetchBranchesForSessionMock.mockResolvedValue([
            { name: 'main', type: 'local', isCurrent: true, upstream: null },
            { name: 'feature/auth', type: 'local', isCurrent: false, upstream: null },
        ]);

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        const screen = await renderScreen(<SourceControlBranchMenu
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
                />);

        await openSourceControlBranchMenu(screen);

        const segmented = screen.findByType('SegmentedTabBar' as any);
        expect(segmented.props.activeTabId).toBe('branches');

        const results = screen.findByType('SelectableMenuResults' as any);
        expect(results.props.categories.some((category: any) => category.items.some((item: any) => item.id === 'branch:feature/auth'))).toBe(true);
        expect(results.props.categories.some((category: any) => category.items.some((item: any) => item.id === 'worktree:open:/repo/.worktrees/feature-auth'))).toBe(false);

        await act(async () => {
            segmented.props.onSelectTab('worktrees');
        });

        const nextResults = screen.findByType('SelectableMenuResults' as any);
        expect(nextResults.props.categories.some((category: any) => category.items.some((item: any) => item.id === 'worktree:open:/repo/.worktrees/feature-auth'))).toBe(true);
    });

    it('removes a sibling worktree through the shared repo worktree service after confirmation', async () => {
        sourceControlBranchMenuModuleState.preferredServerIdForSession = 'server-a';
        sourceControlBranchMenuModuleState.readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo' });
        sourceControlBranchMenuModuleState.modalConfirmSpy.mockResolvedValue(true);
        sourceControlBranchMenuModuleState.removeWorktreeForMachinePathMock.mockResolvedValue({ success: true });

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        const screen = await renderScreen(<SourceControlBranchMenu
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
                />);

        await openSourceControlBranchMenu(screen);
        const segmented = screen.findByType('SegmentedTabBar' as any);
        await act(async () => {
            segmented.props.onSelectTab('worktrees');
        });
        expect(listSourceControlBranchMenuItemIds(screen)).toContain('worktree:remove:/repo/.worktrees/feature-auth');
        await selectSourceControlBranchMenuItem(screen, 'worktree:remove:/repo/.worktrees/feature-auth');

        expect(sourceControlBranchMenuModuleState.removeWorktreeForMachinePathMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            path: '/repo',
            worktreePath: '/repo/.worktrees/feature-auth',
            serverId: 'server-a',
        });
    });
});
