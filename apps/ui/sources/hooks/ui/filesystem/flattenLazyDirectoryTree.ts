import type { LazyDirectoryTreeEntry, LazyDirectoryTreeNode } from './lazyDirectoryTreeTypes';

export function flattenLazyDirectoryTree(input: {
    directoryPath: string;
    depth: number;
    directoryEntriesByPath: Map<string, LazyDirectoryTreeEntry[]>;
    directoryTruncationByPath: Map<string, boolean>;
    expandedDirectories: Set<string>;
    loadingDirectories: Set<string>;
    directoryErrors: Map<string, string>;
    visited: Set<string>;
}): LazyDirectoryTreeNode[] {
    if (input.visited.has(input.directoryPath)) return [];
    input.visited.add(input.directoryPath);

    const entries = input.directoryEntriesByPath.get(input.directoryPath) ?? [];
    const out: LazyDirectoryTreeNode[] = [];

    for (const entry of entries) {
        const isExpanded = entry.type === 'directory' && input.expandedDirectories.has(entry.path);
        const hasChildrenLoaded = entry.type === 'directory' && input.directoryEntriesByPath.has(entry.path);
        const dirErrorMessage = entry.type === 'directory' ? input.directoryErrors.get(entry.path) : undefined;
        const isLoadingChildren = entry.type === 'directory'
            && (input.loadingDirectories.has(entry.path) || (isExpanded && !hasChildrenLoaded && !dirErrorMessage));

        out.push({
            path: entry.path,
            name: entry.name,
            type: entry.type,
            depth: input.depth,
            isExpanded,
            isLoadingChildren,
            sizeBytes: entry.sizeBytes,
            modifiedMs: entry.modifiedMs,
            source: entry.source,
        });

        if (entry.type === 'directory' && isExpanded) {
            if (dirErrorMessage) {
                out.push({
                    path: entry.path,
                    name: '',
                    type: 'error',
                    depth: input.depth + 1,
                    isExpanded: false,
                    isLoadingChildren: false,
                    parentDirectoryPath: entry.path,
                    errorMessage: dirErrorMessage,
                });
                continue;
            }

            out.push(
                ...flattenLazyDirectoryTree({
                    directoryPath: entry.path,
                    depth: input.depth + 1,
                    directoryEntriesByPath: input.directoryEntriesByPath,
                    directoryTruncationByPath: input.directoryTruncationByPath,
                    expandedDirectories: input.expandedDirectories,
                    loadingDirectories: input.loadingDirectories,
                    directoryErrors: input.directoryErrors,
                    visited: input.visited,
                })
            );

            if (input.directoryTruncationByPath.get(entry.path) === true) {
                out.push({
                    path: `${entry.path}#truncated`,
                    name: '',
                    type: 'info',
                    depth: input.depth + 1,
                    isExpanded: false,
                    isLoadingChildren: false,
                    parentDirectoryPath: entry.path,
                    infoKind: 'truncated',
                    entryCount: input.directoryEntriesByPath.get(entry.path)?.length ?? 0,
                });
            }
        }
    }

    return out;
}
