import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    installSourceControlBranchMenuCommonModuleMocks,
    openSourceControlBranchMenu,
    resetSourceControlBranchMenuCommonModuleMockState,
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
        const menu = screen.findByType('DropdownMenu' as any);

        expect(menu.props.items.some((item: any) => item.id === 'worktree:open:/repo/.worktrees/feature-auth')).toBe(true);

        await act(async () => {
            await menu.props.onSelect('worktree:open:/repo/.worktrees/feature-auth');
        });

        expect(sourceControlBranchMenuModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                machineId: undefined,
                directory: '/repo/.worktrees/feature-auth',
            },
        });
    });

    it('creates a worktree session from the current branch through the shared repo worktree service', async () => {
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

        const menu = screen.findByType('DropdownMenu' as any);
        await act(async () => {
            await menu.props.onSelect('worktree:create-current-branch');
        });

        expect(sourceControlBranchMenuModuleState.createWorktreeForMachinePathMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            path: '/repo',
            baseRef: null,
        });
        expect(sourceControlBranchMenuModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                machineId: 'machine-1',
                directory: '/repo/.dev/worktree/feature-auth',
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

        const menu = screen.findByType('DropdownMenu' as any);
        await act(async () => {
            await menu.props.onSelect('worktree:create-current-branch');
        });

        expect(sourceControlBranchMenuModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                machineId: 'machine-1',
                directory: '/repo/.dev/worktree/feature-auth/packages/app',
            },
        });
    });

    it('prunes worktrees through the shared repo worktree service', async () => {
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

        const menu = screen.findByType('DropdownMenu' as any);
        await act(async () => {
            await menu.props.onSelect('worktree:prune');
        });

        expect(sourceControlBranchMenuModuleState.pruneWorktreesForMachinePathMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            path: '/repo',
        });
    });

    it('routes create-from-another-branch into the new-session worktree picker flow', async () => {
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

        const menu = screen.findByType('DropdownMenu' as any);
        await act(async () => {
            await menu.props.onSelect('worktree:create-from-another-branch');
        });

        expect(sourceControlBranchMenuModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                machineId: 'machine-1',
                directory: '/repo',
                worktree: 'new',
            },
        });
    });

    it('removes a sibling worktree through the shared repo worktree service after confirmation', async () => {
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
        const menu = screen.findByType('DropdownMenu' as any);

        expect(menu.props.items.some((item: any) => item.id === 'worktree:remove:/repo/.worktrees/feature-auth')).toBe(true);

        await act(async () => {
            await menu.props.onSelect('worktree:remove:/repo/.worktrees/feature-auth');
        });

        expect(sourceControlBranchMenuModuleState.removeWorktreeForMachinePathMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            path: '/repo',
            worktreePath: '/repo/.worktrees/feature-auth',
        });
    });

    it('checks out a pull request branch from a prompted reference', async () => {
        sourceControlBranchMenuModuleState.modalPromptSpy.mockResolvedValue('glab mr checkout 17');
        sourceControlBranchMenuModuleState.sessionScmPullRequestCheckoutMock.mockResolvedValue({
            success: true,
            branch: 'feature/gitlab',
            headSha: 'abc123',
            baseSha: 'def456',
        });

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        const screen = await renderScreen(<SourceControlBranchMenu
                    sessionId="s1"
                    currentBranch="main"
                    snapshot={{
                        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git', worktrees: [] },
                        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                        capabilities: {
                            readBranches: true,
                            writeBranchCheckout: true,
                            writePullRequestCheckout: true,
                            writePullRequestPrepareWorktree: true,
                        },
                        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
                        fetchedAt: Date.now(),
                        projectKey: 'p1',
                        hasConflicts: false,
                        entries: [],
                        stashCount: 0,
                    } as any}
                />);

        await openSourceControlBranchMenu(screen);
        const menu = screen.findByType('DropdownMenu' as any);

        expect(menu.props.items.some((item: any) => item.id === 'pull-request:checkout-local')).toBe(true);

        await act(async () => {
            await menu.props.onSelect('pull-request:checkout-local');
        });

        expect(sourceControlBranchMenuModuleState.sessionScmPullRequestCheckoutMock).toHaveBeenCalledWith('s1', {
            prReference: { number: 17 },
        });
    });

    it('prepares a pull request worktree and opens a new session at the returned path', async () => {
        sourceControlBranchMenuModuleState.readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/repo/packages/app' });
        sourceControlBranchMenuModuleState.modalPromptSpy.mockResolvedValue('https://github.com/happier/dev/pull/42');
        sourceControlBranchMenuModuleState.sessionScmPullRequestPrepareWorktreeMock.mockResolvedValue({
            success: true,
            targetPath: '/repo/.dev/worktree/pr-42/packages/app',
            branch: 'pr-42',
            head: 'abc123',
        });

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        const screen = await renderScreen(<SourceControlBranchMenu
                    sessionId="s1"
                    currentBranch="main"
                    snapshot={{
                        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git', worktrees: [] },
                        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                        capabilities: {
                            readBranches: true,
                            writeBranchCheckout: true,
                            writePullRequestCheckout: true,
                            writePullRequestPrepareWorktree: true,
                        },
                        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
                        fetchedAt: Date.now(),
                        projectKey: 'p1',
                        hasConflicts: false,
                        entries: [],
                        stashCount: 0,
                    } as any}
                />);

        await openSourceControlBranchMenu(screen);
        const menu = screen.findByType('DropdownMenu' as any);

        expect(menu.props.items.some((item: any) => item.id === 'pull-request:open-worktree')).toBe(true);

        await act(async () => {
            await menu.props.onSelect('pull-request:open-worktree');
        });

        expect(sourceControlBranchMenuModuleState.sessionScmPullRequestPrepareWorktreeMock).toHaveBeenCalledWith('s1', {
            sourcePath: '/repo/packages/app',
            mode: 'worktree',
            prReference: { url: 'https://github.com/happier/dev/pull/42' },
        });
        expect(sourceControlBranchMenuModuleState.invalidateBranchesForSessionMock).toHaveBeenCalledWith({
            sessionId: 's1',
        });
        expect(sourceControlBranchMenuModuleState.invalidateFromMutationAndAwaitMock).toHaveBeenCalledWith('s1');
        expect(sourceControlBranchMenuModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                machineId: 'machine-1',
                directory: '/repo/.dev/worktree/pr-42/packages/app',
            },
        });
    });
});
