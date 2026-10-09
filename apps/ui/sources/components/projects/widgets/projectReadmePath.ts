import type { RepositoryDirectoryEntry } from '@/sync/domains/input/repositoryDirectoryEntries';

/** Root directory entries supply the real filename, including its target-platform case. */
export function readProjectReadmePath(entries: readonly RepositoryDirectoryEntry[]): string | null {
    return entries.find(entry => entry.type === 'file' && /^readme(?:\.md|\.markdown|\.txt)?$/i.test(entry.name))?.name ?? null;
}
