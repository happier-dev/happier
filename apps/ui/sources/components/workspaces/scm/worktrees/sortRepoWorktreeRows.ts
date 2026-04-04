export type SortableRepoWorktreeRow = Readonly<{
    path: string;
    branch: string | null;
    isCurrent?: boolean;
}>;

export function sortRepoWorktreeRows<T extends SortableRepoWorktreeRow>(rows: ReadonlyArray<T>): T[] {
    return [...rows].sort((left, right) => {
        if (left.isCurrent === true && right.isCurrent !== true) return -1;
        if (left.isCurrent !== true && right.isCurrent === true) return 1;
        return (left.branch ?? left.path).localeCompare(right.branch ?? right.path);
    });
}
