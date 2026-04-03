import { sortDirectoryEntries } from './sortDirectoryEntries';

export type RepositoryDirectoryEntry = {
    name: string;
    type: 'file' | 'directory';
    sizeBytes?: number;
    modifiedMs?: number;
};

export type ListRepositoryDirectoryEntriesResult =
    | { ok: true; entries: RepositoryDirectoryEntry[] }
    | { ok: false; error: string };

export function sortRepositoryDirectoryEntries(entries: RepositoryDirectoryEntry[]): RepositoryDirectoryEntry[] {
    return sortDirectoryEntries(entries);
}
