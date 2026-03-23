type SortableDirectoryEntry = Readonly<{
    name: string;
    type: 'file' | 'directory';
}>;

function normalizeName(name: string): string {
    return name.normalize('NFKC');
}

export function sortDirectoryEntries<TEntry extends SortableDirectoryEntry>(entries: readonly TEntry[]): TEntry[] {
    const copy = entries.slice();
    copy.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
        }
        return normalizeName(a.name).localeCompare(normalizeName(b.name), undefined, { sensitivity: 'base' });
    });
    return copy;
}
