import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';

import { canonicalizeWorktreePath } from './worktreePathComparison';

/**
 * Canonical SelectionList option id for an existing-worktree checkout row.
 *
 * The chip model (which computes the worktree popover's `selectedOptionId`) and
 * the worktree step builder (which emits the rows) MUST derive this id from a
 * worktree path identically — otherwise a currently-selected existing worktree
 * fails to highlight / scroll into view on reopen whenever the raw path needs
 * normalization (trailing slash, mixed separators, tilde-vs-absolute). Routing
 * both through this single owner makes the two sides impossible to drift apart.
 */
export function buildWorktreeCheckoutOptionId(
    path: string,
    options?: Readonly<{
        machineHomeDir?: string | null;
        machinePlatform?: string | null;
    }>,
): `checkout:${string}` {
    const canonicalPath = canonicalizeWorktreePath(
        path,
        options?.machineHomeDir ?? null,
        options?.machinePlatform ?? null,
    );
    return `checkout:${canonicalPath ?? normalizeFileSystemPath(path) ?? path}`;
}
