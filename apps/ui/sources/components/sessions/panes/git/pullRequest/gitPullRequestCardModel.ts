import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

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
