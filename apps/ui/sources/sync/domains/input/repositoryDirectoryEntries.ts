import { sortDirectoryEntries } from './sortDirectoryEntries';
import type { WorkspaceListDirectoryResponse } from '@/sync/ops/workspaceFileSystem/directoryBrowsing';

export type RepositoryDirectoryEntry = {
    name: string;
    gitIgnored?: boolean;
    type: 'file' | 'directory';
    sizeBytes?: number;
    modifiedMs?: number;
};

export type ListRepositoryDirectoryEntriesResult =
    | { ok: true; entries: RepositoryDirectoryEntry[]; gitIgnoreAvailable?: boolean; truncated?: boolean }
    | { ok: false; error: string; errorCode?: Extract<WorkspaceListDirectoryResponse, { success: false }>['errorCode'] };

export function sortRepositoryDirectoryEntries(entries: RepositoryDirectoryEntry[]): RepositoryDirectoryEntry[] {
    return sortDirectoryEntries(entries);
}
