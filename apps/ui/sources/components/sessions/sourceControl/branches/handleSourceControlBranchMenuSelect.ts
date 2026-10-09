import type { Router } from 'expo-router';

import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { seedAndOpenNewSession } from '@/components/sessions/new/newSessionSeedComposer';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

export type SourceControlBranchMenuMachineTarget = Readonly<{
    machineId: string;
    basePath: string;
}> | null;

export async function handleSourceControlBranchMenuSelect(input: Readonly<{
    itemId: string;
    closeMenu: () => void;
    createWorktreeFromCurrentBranch: () => Promise<void>;
    directoryFallback: string;
    machineTarget: SourceControlBranchMenuMachineTarget;
    openNewSessionForDirectory: (directory: string) => void;
    pruneWorktrees: () => Promise<void>;
    removeWorktree: (worktreePath: string) => Promise<void>;
    router: Router;
    setIncludeRemotes: (value: boolean) => void;
    setOpen: (value: boolean) => void;
    switchBranch: (branchName: string) => Promise<void>;
    targetServerId?: string | null;
}>): Promise<void> {
    const { itemId } = input;

    if (itemId === 'worktree:create-current-branch') {
        await input.createWorktreeFromCurrentBranch();
        return;
    }
    if (itemId === 'worktree:create-from-another-branch') {
        input.closeMenu();
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) return;
        seedAndOpenNewSession({
            seed: {
                placement: input.machineTarget?.machineId
                    ? { kind: 'exactTarget', serverId: input.targetServerId || lifetime.scope.serverId,
                        machineId: input.machineTarget.machineId, ...(input.directoryFallback ? { directory: input.directoryFallback } : {}) }
                    : { kind: 'currentTarget', ...(input.directoryFallback ? { directory: input.directoryFallback } : {}) },
                checkoutIntent: 'createWorktree',
            },
            scope: lifetime.scope,
            isCurrent: lifetime.isCurrent,
            navigateToNewSession: ({ draftId, worktree }) => input.router.push({
                pathname: '/new', params: buildNewSessionLaunchRouteParams({ draftId, worktree,
                    ...(!input.machineTarget?.machineId ? { targetServerId: input.targetServerId } : {}) }),
            }),
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
