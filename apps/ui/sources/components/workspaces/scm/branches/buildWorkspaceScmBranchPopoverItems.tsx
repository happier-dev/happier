import * as React from 'react';

import type { ScmBranchListEntry } from '@happier-dev/protocol';

import type { SelectableMenuItem } from '@/components/ui/forms/dropdown/selectableMenuTypes';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

export type RepoWorktreeRow = Readonly<{
    path: string;
    branch: string | null;
    isCurrent?: boolean;
    isMain?: boolean;
    isPrunable?: boolean;
}>;

export function buildWorkspaceScmBranchPopoverItems(input: Readonly<{
    branches: ReadonlyArray<ScmBranchListEntry>;
    canCheckout: boolean;
    canCreateWorktrees: boolean;
    canLaunchWorktreeSession: boolean;
    canReadBranches: boolean;
    currentBranch: string | null;
    hasMachineTarget: boolean;
    includeRemotes: boolean;
    loading: boolean;
    worktreeRows: ReadonlyArray<RepoWorktreeRow>;
    checkIconColor: string;
}>): Readonly<{
    branchItems: ReadonlyArray<SelectableMenuItem>;
    worktreeItems: ReadonlyArray<SelectableMenuItem>;
}> {
    const branchItems: SelectableMenuItem[] = [];
    const worktreeItems: SelectableMenuItem[] = [];

    if (input.canCreateWorktrees) {
        worktreeItems.push({
            id: 'worktree:create-current-branch',
            title: t('files.branchMenu.worktrees.createFromCurrentBranchTitle'),
            subtitle: input.currentBranch
                ? t('files.branchMenu.worktrees.createFromCurrentBranchSubtitle', { branch: input.currentBranch })
                : t('files.branchMenu.worktrees.createFromCurrentBranchDetachedSubtitle'),
            category: t('files.branchMenu.category.actions'),
            disabled: !input.hasMachineTarget || !input.currentBranch,
        });
        worktreeItems.push({
            id: 'worktree:create-from-another-branch',
            title: t('files.branchMenu.worktrees.createFromAnotherBranchTitle'),
            subtitle: t('files.branchMenu.worktrees.createFromAnotherBranchSubtitle'),
            category: t('files.branchMenu.category.actions'),
        });
        worktreeItems.push({
            id: 'worktree:prune',
            title: t('files.branchMenu.worktrees.pruneTitle'),
            subtitle: t('files.branchMenu.worktrees.pruneSubtitle'),
            category: t('files.branchMenu.category.actions'),
            disabled: !input.hasMachineTarget,
        });
    }

    if (input.canLaunchWorktreeSession && input.worktreeRows.length > 0) {
        for (const worktree of input.worktreeRows) {
            const title = worktree.branch ?? worktree.path;
            worktreeItems.push({
                id: `worktree:open:${worktree.path}`,
                title,
                subtitle: worktree.path,
                category: t('files.branchMenu.category.worktrees'),
                disabled: worktree.isCurrent === true,
                right: worktree.isCurrent ? (
                    <Icon name="check" size={14} color={input.checkIconColor} />
                ) : null,
            });

            if (input.canCreateWorktrees && worktree.isCurrent !== true && worktree.isMain !== true) {
                worktreeItems.push({
                    id: `worktree:remove:${worktree.path}`,
                    title: t('files.branchMenu.worktrees.removeTitle'),
                    subtitle: t('files.branchMenu.worktrees.removeSubtitle', { target: worktree.branch ?? worktree.path }),
                    category: t('files.branchMenu.category.actions'),
                });
            }
        }
    }

    if (input.loading && input.branches.length === 0) {
        branchItems.push({
            id: 'loading',
            title: t('common.loading'),
            disabled: true,
            category: t('files.branchMenu.category.branches'),
        });
        return { branchItems, worktreeItems };
    }

    if (!input.canReadBranches) {
        branchItems.push({
            id: 'unsupported',
            title: t('files.branchMenu.unavailable'),
            disabled: true,
            category: t('files.branchMenu.category.branches'),
        });
        return { branchItems, worktreeItems };
    }

    for (const branch of input.branches) {
        const isCurrent = branch.isCurrent === true || (input.currentBranch ? branch.name === input.currentBranch : false);
        branchItems.push({
            id: `branch:${branch.name}`,
            title: branch.name,
            subtitle: branch.upstream ? t('files.branchMenu.branch.upstream', { upstream: branch.upstream }) : undefined,
            category: branch.type === 'remote'
                ? t('files.branchMenu.category.remote')
                : t('files.branchMenu.category.local'),
            disabled: !input.canCheckout || isCurrent,
            right: isCurrent ? (
                <Icon name="check" size={14} color={input.checkIconColor} />
            ) : null,
        });
    }

    branchItems.push({
        id: input.includeRemotes ? 'remotes_off' : 'remotes_on',
        title: input.includeRemotes ? t('files.branchMenu.remotes.hide') : t('files.branchMenu.remotes.show'),
        subtitle: t('files.branchMenu.remotes.subtitle'),
        category: t('files.branchMenu.category.options'),
        disabled: !input.canReadBranches,
    });

    return { branchItems, worktreeItems };
}
