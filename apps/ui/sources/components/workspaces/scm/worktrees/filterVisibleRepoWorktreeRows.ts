import type { RepoWorktreeRow } from '../branches/buildWorkspaceScmBranchPopoverItems';

export function filterVisibleRepoWorktreeRows<T extends RepoWorktreeRow>(rows: ReadonlyArray<T>): T[] {
    return rows.filter((row) => row.isPrunable !== true);
}
