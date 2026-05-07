import type { Router } from 'expo-router';

export type SourceControlBranchMenuMachineTarget = Readonly<{
    machineId: string;
    basePath: string;
}> | null;

export async function handleSourceControlBranchMenuSelect(input: Readonly<{
    itemId: string;
    closeMenu: () => void;
    checkoutPullRequestLocally: () => Promise<void>;
    createWorktreeFromCurrentBranch: () => Promise<void>;
    directoryFallback: string;
    machineTarget: SourceControlBranchMenuMachineTarget;
    openPullRequestWorktree: () => Promise<void>;
    openNewSessionForDirectory: (directory: string) => void;
    pruneWorktrees: () => Promise<void>;
    removeWorktree: (worktreePath: string) => Promise<void>;
    router: Router;
    setIncludeRemotes: (value: boolean) => void;
    setOpen: (value: boolean) => void;
    switchBranch: (branchName: string) => Promise<void>;
}>): Promise<void> {
    const { itemId } = input;

    if (itemId === 'worktree:create-current-branch') {
        await input.createWorktreeFromCurrentBranch();
        return;
    }
    if (itemId === 'pull-request:checkout-local') {
        await input.checkoutPullRequestLocally();
        return;
    }
    if (itemId === 'pull-request:open-worktree') {
        await input.openPullRequestWorktree();
        return;
    }
    if (itemId === 'worktree:create-from-another-branch') {
        input.closeMenu();
        input.router.push({
            pathname: '/new',
            params: input.machineTarget?.machineId
                ? {
                    machineId: input.machineTarget.machineId,
                    directory: input.directoryFallback,
                    worktree: 'new',
                }
                : {
                    directory: input.directoryFallback,
                    worktree: 'new',
                },
        });
        return;
    }
    if (itemId === 'worktree:prune') {
        await input.pruneWorktrees();
        return;
    }
    if (itemId.startsWith('worktree:open:')) {
        input.closeMenu();
        input.openNewSessionForDirectory(itemId.slice('worktree:open:'.length));
        return;
    }
    if (itemId.startsWith('worktree:remove:')) {
        await input.removeWorktree(itemId.slice('worktree:remove:'.length));
        return;
    }
    if (itemId === 'remotes_on') {
        input.setIncludeRemotes(true);
        input.setOpen(true);
        return;
    }
    if (itemId === 'remotes_off') {
        input.setIncludeRemotes(false);
        input.setOpen(true);
        return;
    }
    if (itemId.startsWith('branch:')) {
        await input.switchBranch(itemId.slice('branch:'.length));
        return;
    }
}
