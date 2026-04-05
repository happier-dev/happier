export type RepoWorktreeIdentityRow = Readonly<{
    id?: string;
    path: string;
    isPrunable?: boolean;
}>;

function normalizeComparableString(rawValue: string | null | undefined): string {
    return String(rawValue ?? '').trim();
}

function isVisibleWorktree(row: RepoWorktreeIdentityRow): boolean {
    return row.isPrunable !== true && normalizeComparableString(row.path).length > 0;
}

export function findVisibleRepoWorktreeById<T extends RepoWorktreeIdentityRow>(
    rows: ReadonlyArray<T> | null | undefined,
    worktreeId: string | null | undefined,
): T | null {
    const normalizedId = normalizeComparableString(worktreeId);
    if (!normalizedId || !Array.isArray(rows)) return null;
    return rows.find((row) => isVisibleWorktree(row) && normalizeComparableString(row.id) === normalizedId) ?? null;
}

export function findVisibleRepoWorktreeByPath<T extends RepoWorktreeIdentityRow>(
    rows: ReadonlyArray<T> | null | undefined,
    worktreePath: string | null | undefined,
): T | null {
    const normalizedPath = normalizeComparableString(worktreePath);
    if (!normalizedPath || !Array.isArray(rows)) return null;
    return rows.find((row) => isVisibleWorktree(row) && normalizeComparableString(row.path) === normalizedPath) ?? null;
}
