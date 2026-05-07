import * as React from 'react';
import { Octicons } from '@expo/vector-icons';

import type { ScmBranchListEntry } from '@happier-dev/protocol';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';

export type RepoWorktreeRow = Readonly<{
    path: string;
    branch: string | null;
    isCurrent?: boolean;
    isMain?: boolean;
}>;

export function buildSourceControlBranchMenuItems(input: Readonly<{
    branches: ReadonlyArray<ScmBranchListEntry>;
    canCheckout: boolean;
    canCreateWorktrees: boolean;
    canLaunchWorktreeSession: boolean;
    canCheckoutPullRequests: boolean;
    canPreparePullRequestWorktrees: boolean;
    canReadBranches: boolean;
    currentBranch: string | null;
    hasMachineTarget: boolean;
    includeRemotes: boolean;
    loading: boolean;
    worktreeRows: ReadonlyArray<RepoWorktreeRow>;
    checkIconColor: string;
}>): ReadonlyArray<DropdownMenuItem> {
    const {
        branches,
        canCheckout,
        canCreateWorktrees,
        canLaunchWorktreeSession,
        canCheckoutPullRequests,
        canPreparePullRequestWorktrees,
        canReadBranches,
        currentBranch,
        hasMachineTarget,
        includeRemotes,
        loading,
        worktreeRows,
        checkIconColor,
    } = input;

    const out: DropdownMenuItem[] = [];

    if (canCreateWorktrees) {
        out.push({
            id: 'worktree:create-current-branch',
            title: t('files.branchMenu.worktrees.createFromCurrentBranchTitle'),
            subtitle: currentBranch
                ? t('files.branchMenu.worktrees.createFromCurrentBranchSubtitle', { branch: currentBranch })
                : t('files.branchMenu.worktrees.createFromCurrentBranchDetachedSubtitle'),
            category: t('files.branchMenu.category.actions'),
            disabled: !hasMachineTarget || !currentBranch,
        });
        out.push({
            id: 'worktree:create-from-another-branch',
            title: t('files.branchMenu.worktrees.createFromAnotherBranchTitle'),
            subtitle: t('files.branchMenu.worktrees.createFromAnotherBranchSubtitle'),
            category: t('files.branchMenu.category.actions'),
        });
        out.push({
            id: 'worktree:prune',
            title: t('files.branchMenu.worktrees.pruneTitle'),
            subtitle: t('files.branchMenu.worktrees.pruneSubtitle'),
            category: t('files.branchMenu.category.actions'),
            disabled: !hasMachineTarget,
        });
    }

    if (canCheckoutPullRequests || canPreparePullRequestWorktrees) {
        out.push({
            id: 'pull-request:checkout-local',
            title: t('files.branchMenu.pullRequests.checkoutLocalTitle'),
            subtitle: t('files.branchMenu.pullRequests.checkoutLocalSubtitle'),
            category: t('files.branchMenu.category.actions'),
            disabled: !canCheckoutPullRequests,
        });
        out.push({
            id: 'pull-request:open-worktree',
            title: t('files.branchMenu.pullRequests.openWorktreeTitle'),
            subtitle: t('files.branchMenu.pullRequests.openWorktreeSubtitle'),
            category: t('files.branchMenu.category.actions'),
            disabled: !canPreparePullRequestWorktrees || !hasMachineTarget,
        });
    }

    if (canLaunchWorktreeSession && worktreeRows.length > 0) {
        for (const worktree of worktreeRows) {
            const title = worktree.branch ?? worktree.path;
            out.push({
                id: `worktree:open:${worktree.path}`,
                title,
                subtitle: worktree.path,
                category: t('files.branchMenu.category.worktrees'),
                disabled: worktree.isCurrent === true,
                rightElement: worktree.isCurrent ? (
                    <Octicons name="check" size={14} color={checkIconColor} />
                ) : null,
            });

            if (canCreateWorktrees && worktree.isCurrent !== true && worktree.isMain !== true) {
                out.push({
                    id: `worktree:remove:${worktree.path}`,
                    title: t('files.branchMenu.worktrees.removeTitle'),
                    subtitle: t('files.branchMenu.worktrees.removeSubtitle', { target: worktree.branch ?? worktree.path }),
                    category: t('files.branchMenu.category.actions'),
                });
            }
        }
    }

    if (loading && branches.length === 0) {
        out.push({
            id: 'loading',
            title: t('common.loading'),
            disabled: true,
            category: t('files.branchMenu.category.branches'),
        });
        return out;
    }

    if (!canReadBranches) {
        out.push({
            id: 'unsupported',
            title: t('files.branchMenu.unavailable'),
            disabled: true,
            category: t('files.branchMenu.category.branches'),
        });
        return out;
    }

    for (const branch of branches) {
        const isCurrent = branch.isCurrent === true || (currentBranch ? branch.name === currentBranch : false);
        out.push({
            id: `branch:${branch.name}`,
            title: branch.name,
            subtitle: branch.upstream ? t('files.branchMenu.branch.upstream', { upstream: branch.upstream }) : undefined,
            category: branch.type === 'remote'
                ? t('files.branchMenu.category.remote')
                : t('files.branchMenu.category.local'),
            disabled: !canCheckout || isCurrent,
            rightElement: isCurrent ? (
                <Octicons name="check" size={14} color={checkIconColor} />
            ) : null,
        });
    }

    out.push({
        id: includeRemotes ? 'remotes_off' : 'remotes_on',
        title: includeRemotes ? t('files.branchMenu.remotes.hide') : t('files.branchMenu.remotes.show'),
        subtitle: t('files.branchMenu.remotes.subtitle'),
        category: t('files.branchMenu.category.options'),
        disabled: !canReadBranches,
    });

    return out;
}
