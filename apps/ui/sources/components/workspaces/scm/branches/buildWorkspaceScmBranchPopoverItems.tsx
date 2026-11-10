import * as React from 'react';

import type { ScmBranchListEntry} from '@happier-dev/protocol/scm/branches';
import type { ScmStashEntry } from '@happier-dev/protocol/scm';

import type { SelectableMenuItem } from '@/components/ui/forms/dropdown/selectableMenuTypes';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { formatScmTimelineWhen } from '@/scm/history/historyPresentation';
import { resolveScmStashIconName, resolveScmStashOrigin, resolveScmStashTitle } from '@/scm/stash/stashPresentation';

export type RepoWorktreeRow = Readonly<{
    path: string;
    branch: string | null;
    isCurrent?: boolean;
    isMain?: boolean;
    isPrunable?: boolean;
}>;

/** Item ids the branch popover's owner handles besides `branch:*`, `worktree:*` and the remotes toggle. */
export const GIT_BRANCH_MENU_ITEM_IDS = Object.freeze({
    newBranch: 'git:new-branch',
    keepAside: 'git:keep-aside',
    stashPrefix: 'stash:',
});

/**
 * The branch popover's rows (Git lab BR), one list read top to bottom: where you are (the current branch, what
 * it tracks, what is waiting), the other branches, what Happier kept aside, the worktrees, then what you can
 * start. Rows a surface cannot back are left out (no recency exists, so there is no "Recent" section); an
 * operation a daemon can't run is not offered, and one that can't run *now* says why.
 */
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
    /** The working tree's facts for the current row (session pane); omitted, the row shows only what it tracks. */
    current?: Readonly<{ changedCount: number; ahead: number }>;
    /** Stashes to list under "Kept aside" (session pane). */
    keptAside?: ReadonlyArray<ScmStashEntry>;
    /** "Keep changes aside": offered only when the daemon can create a stash. */
    keepAside?: Readonly<{ available: boolean; changedCount: number }>;
    /** "New branch from <head>…": offered when a branch can be created. */
    newBranch?: Readonly<{ available: boolean }>;
    /** A load failure to say in the list instead of a dialog. */
    loadError?: string | null;
}>): Readonly<{
    branchItems: ReadonlyArray<SelectableMenuItem>;
    worktreeItems: ReadonlyArray<SelectableMenuItem>;
}> {
    const branchItems: SelectableMenuItem[] = [];
    const worktreeItems: SelectableMenuItem[] = [];
    const glyph = (name: React.ComponentProps<typeof Icon>['name']) => <Icon name={name} size={15} color={input.checkIconColor} />;
    const startCategory = t('sessionGitBranches.category.start');

    if (input.canCreateWorktrees) {
        worktreeItems.push({
            id: 'worktree:create-current-branch',
            title: t('files.branchMenu.worktrees.createFromCurrentBranchTitle'),
            subtitle: input.currentBranch
                ? t('files.branchMenu.worktrees.createFromCurrentBranchSubtitle', { branch: input.currentBranch })
                : t('files.branchMenu.worktrees.createFromCurrentBranchDetachedSubtitle'),
            category: t('sessionGitBranches.category.worktrees'),
            left: glyph('git-branch'),
            disabled: !input.hasMachineTarget || !input.currentBranch,
        });
        worktreeItems.push({
            id: 'worktree:prune',
            title: t('files.branchMenu.worktrees.pruneTitle'),
            subtitle: t('files.branchMenu.worktrees.pruneSubtitle'),
            category: t('sessionGitBranches.category.worktrees'),
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
                category: t('sessionGitBranches.category.worktrees'),
                left: glyph('git-branch'),
                disabled: worktree.isCurrent === true,
                checked: worktree.isCurrent === true,
            });

            if (input.canCreateWorktrees && worktree.isCurrent !== true && worktree.isMain !== true) {
                worktreeItems.push({
                    id: `worktree:remove:${worktree.path}`,
                    title: t('files.branchMenu.worktrees.removeTitle'),
                    subtitle: t('files.branchMenu.worktrees.removeSubtitle', { target: worktree.branch ?? worktree.path }),
                    category: t('sessionGitBranches.category.worktrees'),
                });
            }
        }
    }

    if (input.canCreateWorktrees) {
        worktreeItems.push({
            id: 'worktree:create-from-another-branch',
            title: t('sessionGitBranches.newWorktree'),
            subtitle: t('sessionGitBranches.newWorktreeSubtitle'),
            category: startCategory,
            left: glyph('git-branch'),
        });
    }

    if (input.loading && input.branches.length === 0) {
        branchItems.push({
            id: 'loading',
            title: t('common.loading'),
            disabled: true,
            category: t('sessionGitBranches.category.branches'),
        });
    } else if (!input.canReadBranches) {
        branchItems.push({
            id: 'unsupported',
            title: t('files.branchMenu.unavailable'),
            disabled: true,
            category: t('sessionGitBranches.category.branches'),
        });
    } else {
        const current = input.currentBranch;
        const currentEntry = input.branches.find((branch) => branch.isCurrent === true || (current !== null && branch.name === current));
        if (currentEntry) {
            const facts = [
                currentEntry.upstream ? t('sessionGitBranches.tracks', { upstream: currentEntry.upstream }) : t('sessionGitBranches.onlyHere'),
                input.current && input.current.changedCount > 0
                    ? t('sessionGitBranches.changed', { count: formatExactCount(input.current.changedCount) })
                    : null,
            ].filter((fact): fact is string => Boolean(fact));
            branchItems.push({
                id: `branch:${currentEntry.name}`,
                title: currentEntry.name,
                subtitle: facts.join(' · '),
                category: t('sessionGitBranches.category.current'),
                left: glyph('git-branch'),
                checked: true,
                accessibilityLabel: [currentEntry.name, ...facts].join(', '),
                // The menu draws the check beside this designation.
                right: input.current && input.current.ahead > 0 ? (
                    <Icon name="arrow-up" size={12} color={input.checkIconColor} accessibilityLabel={t('sessionGitBranches.ahead', { count: formatExactCount(input.current.ahead) })} />
                ) : null,
            });
        }
        for (const branch of input.branches) {
            if (branch === currentEntry) continue;
            branchItems.push({
                id: `branch:${branch.name}`,
                title: branch.name,
                subtitle: branch.upstream
                    ? t('sessionGitBranches.tracks', { upstream: branch.upstream })
                    : branch.type === 'remote' ? undefined : t('sessionGitBranches.onlyHere'),
                category: branch.type === 'remote'
                    ? t('sessionGitBranches.category.remote')
                    : t('sessionGitBranches.category.branches'),
                left: glyph('git-branch'),
                disabled: !input.canCheckout,
            });
        }
        if (input.loadError) {
            branchItems.push({
                id: 'load-error',
                title: t('sessionGitBranches.loadFailed'),
                subtitle: input.loadError,
                disabled: true,
                category: t('sessionGitBranches.category.branches'),
            });
        }
        branchItems.push({
            id: input.includeRemotes ? 'remotes_off' : 'remotes_on',
            title: input.includeRemotes ? t('files.branchMenu.remotes.hide') : t('files.branchMenu.remotes.show'),
            category: input.includeRemotes ? t('sessionGitBranches.category.remote') : t('sessionGitBranches.category.branches'),
        });
    }

    for (const stash of input.keptAside ?? []) {
        const when = typeof stash.createdAt === 'number' ? formatScmTimelineWhen(stash.createdAt) : '';
        const origin = resolveScmStashOrigin(stash, 'short');
        branchItems.push({
            id: `${GIT_BRANCH_MENU_ITEM_IDS.stashPrefix}${stash.stashRef}`,
            title: resolveScmStashTitle(stash),
            subtitle: when ? t('sessionGitBranches.keptAsideWhen', { origin, when }) : origin,
            category: t('sessionGitBranches.category.keptAside'),
            left: glyph(resolveScmStashIconName(stash)),
        });
    }

    if (input.newBranch?.available) {
        branchItems.push({
            id: GIT_BRANCH_MENU_ITEM_IDS.newBranch,
            title: input.currentBranch
                ? t('sessionGitBranches.newBranch', { branch: input.currentBranch })
                : t('sessionGitBranches.newBranchDetached'),
            subtitle: t('sessionGitBranches.newBranchSubtitle'),
            category: startCategory,
            left: glyph('plus'),
        });
    }
    if (input.keepAside?.available) {
        const nothing = input.keepAside.changedCount === 0;
        branchItems.push({
            id: GIT_BRANCH_MENU_ITEM_IDS.keepAside,
            title: t('sessionGitBranches.keepAside'),
            subtitle: nothing
                ? t('sessionGitBranches.keepAsideNothing')
                : t('sessionGitBranches.keepAsideSubtitle', { count: formatExactCount(input.keepAside.changedCount) }),
            category: startCategory,
            left: glyph('archive'),
            disabled: nothing,
        });
    }

    return { branchItems, worktreeItems };
}
