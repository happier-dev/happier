import type { ScmStashEntry } from '@happier-dev/protocol/scm';

/**
 * The changes Happier kept aside for this branch when you switched away from it (a branch-kind stash named for
 * the branch). Coming back to the branch, the Git pane offers to put them back (lab SZ). Stashes made outside a
 * branch switch never qualify: Happier did not promise to bring those back here.
 */
export function selectKeptAsideStash(
    stashes: readonly ScmStashEntry[],
    branch: string | null | undefined,
): ScmStashEntry | null {
    const current = branch?.trim();
    if (!current) return null;
    return stashes.find((entry) => entry.kind === 'branch' && entry.branch?.trim() === current) ?? null;
}
