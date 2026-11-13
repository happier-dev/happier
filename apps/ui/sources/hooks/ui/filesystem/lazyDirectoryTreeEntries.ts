import type { LazyDirectoryTreeEntry } from './lazyDirectoryTreeTypes';

export function isLoadedDirectory(entries: readonly LazyDirectoryTreeEntry[] | undefined): boolean {
    return entries !== undefined && !(entries.length > 0 && entries.every((entry) => entry.source === 'preview'));
}
