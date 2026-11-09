import { sortDirectoryEntries } from './sortDirectoryEntries';

export type RepositoryDirectoryEntry = {
    name: string;
    gitIgnored?: boolean;
    type: 'file' | 'directory';
    sizeBytes?: number;
    modifiedMs?: number;
};

export type ListRepositoryDirectoryEntriesResult =
    | { ok: true; entries: RepositoryDirectoryEntry[]; gitIgnoreAvailable?: boolean; truncated?: boolean }
    | { ok: false; error: string };

export function sortRepositoryDirectoryEntries(entries: RepositoryDirectoryEntry[]): RepositoryDirectoryEntry[] {
    return sortDirectoryEntries(entries);
}
