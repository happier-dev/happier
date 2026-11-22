import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { IconName } from '@/components/ui/icons/Icon';

import type { GitPullRequestCardModel } from './GitPullRequestCard';

/**
 * The generic fallback reads SCM's branch observation. Created results go to the contributed slot as hints.
 */
export function resolveGitPullRequestCardModel(
    snapshot: ScmWorkingSnapshot | null,
): GitPullRequestCardModel | null {
    const open = snapshot?.pullRequestStatus?.openPullRequest ?? null;
    if (open) {
        return {
            number: open.number ?? null,
            url: open.url,
            title: open.title,
            base: open.baseBranch,
            state: open.isDraft && open.state === 'open' ? 'draft' : open.state,
            checks: open.checks?.state ?? null,
            providerKind: open.provider.kind,
            providerName: open.provider.displayName,
        };
    }
    return null;
}

/** The one glyph for a pull request's state: merged, draft, or the pull request itself (open, closed, unknown). */
export function resolveGitPullRequestStateIconName(state: GitPullRequestCardModel['state']): IconName {
    return state === 'merged' ? 'git-merge' : state === 'draft' ? 'git-pull-request-draft' : 'git-pull-request';
}
