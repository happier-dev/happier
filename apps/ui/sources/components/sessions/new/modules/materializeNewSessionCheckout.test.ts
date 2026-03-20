import { beforeEach, describe, expect, it, vi } from 'vitest';

const createWorktreeForMachinePathSpy = vi.hoisted(() => vi.fn());

vi.mock('@/scm/repository/repoScmWorktreeService', () => ({
    repoScmWorktreeService: {
        createWorktreeForMachinePath: (...args: unknown[]) => createWorktreeForMachinePathSpy(...args),
    },
}));

describe('materializeNewSessionCheckout', () => {
    beforeEach(() => {
        createWorktreeForMachinePathSpy.mockReset();
    });

    it('preserves the selected subdirectory relative to the source worktree root when creating a sibling worktree', async () => {
        createWorktreeForMachinePathSpy.mockResolvedValueOnce({
            success: true,
            worktreePath: '/repo/.dev/worktree/feature/auth',
            branchName: 'feature/auth',
            sourceRootPath: '/repo-linked',
            repositoryRootPath: '/repo',
        });

        const { materializeNewSessionCheckout } = await import('./materializeNewSessionCheckout');
        const result = await materializeNewSessionCheckout({
            machineId: 'machine-1',
            selectedPath: '/repo-linked/packages/app',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: null,
            },
        });

        expect(result).toEqual({
            success: true,
            path: '/repo/.dev/worktree/feature/auth',
            sessionPath: '/repo/.dev/worktree/feature/auth/packages/app',
            repositoryRootPath: '/repo',
        });
    });

    it('preserves a nested Windows subdirectory when the selected path casing differs from the source root', async () => {
        createWorktreeForMachinePathSpy.mockResolvedValueOnce({
            success: true,
            worktreePath: 'C:/Repo/.dev/worktree/feature/auth',
            branchName: 'feature/auth',
            sourceRootPath: 'c:/repo-linked',
            repositoryRootPath: 'C:/Repo',
        });

        const { materializeNewSessionCheckout } = await import('./materializeNewSessionCheckout');
        const result = await materializeNewSessionCheckout({
            machineId: 'machine-1',
            selectedPath: 'C:/Repo-Linked/Packages/App',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: null,
            },
        });

        expect(result).toEqual({
            success: true,
            path: 'C:/Repo/.dev/worktree/feature/auth',
            sessionPath: 'c:/Repo/.dev/worktree/feature/auth/Packages/App',
            repositoryRootPath: 'C:/Repo',
        });
    });

    it('keeps posix resolution case-sensitive when the selected path only differs by casing', async () => {
        createWorktreeForMachinePathSpy.mockResolvedValueOnce({
            success: true,
            worktreePath: '/repo/.dev/worktree/feature/auth',
            branchName: 'feature/auth',
            sourceRootPath: '/repo-linked',
            repositoryRootPath: '/repo',
        });

        const { materializeNewSessionCheckout } = await import('./materializeNewSessionCheckout');
        const result = await materializeNewSessionCheckout({
            machineId: 'machine-1',
            selectedPath: '/Repo-Linked/packages/app',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: null,
            },
        });

        expect(result).toEqual({
            success: true,
            path: '/repo/.dev/worktree/feature/auth',
            sessionPath: '/repo/.dev/worktree/feature/auth',
            repositoryRootPath: '/repo',
        });
    });

    it('forwards existing-branch worktree creation mode to the canonical repo worktree service', async () => {
        createWorktreeForMachinePathSpy.mockResolvedValueOnce({
            success: true,
            worktreePath: '/repo/.dev/worktree/feature/auth',
            branchName: 'feature/auth',
            sourceRootPath: '/repo',
            repositoryRootPath: '/repo',
        });

        const { materializeNewSessionCheckout } = await import('./materializeNewSessionCheckout');
        const result = await materializeNewSessionCheckout({
            machineId: 'machine-1',
            selectedPath: '/repo/packages/app',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: null,
                branchMode: 'existing',
            },
        });

        expect(createWorktreeForMachinePathSpy).toHaveBeenCalledWith({
            machineId: 'machine-1',
            path: '/repo/packages/app',
            displayName: 'feature/auth',
            baseRef: null,
            branchMode: 'existing',
        });
        expect(result).toEqual({
            success: true,
            path: '/repo/.dev/worktree/feature/auth',
            sessionPath: '/repo/.dev/worktree/feature/auth/packages/app',
            repositoryRootPath: '/repo',
        });
    });
});
