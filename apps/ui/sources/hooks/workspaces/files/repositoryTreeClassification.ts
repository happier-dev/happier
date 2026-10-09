import type { RepositoryDirectoryEntry } from '@/sync/domains/input/repositoryDirectoryEntries';

export function readRepositoryTreeClassification(
    nodes: readonly { path: string; type: string; isExpanded?: boolean }[],
    getDirectory: (path: string) => Readonly<{ available?: boolean; entries: readonly RepositoryDirectoryEntry[] | null }>,
    rootDirectoryPath = '',
): { available: boolean | undefined; ignoredPaths: ReadonlySet<string> } {
    const root = getDirectory(rootDirectoryPath);
    const ignoredPaths = new Set<string>();
    if (root.available !== true) return { available: root.available, ignoredPaths };
    const directories = new Set([rootDirectoryPath]);
    for (const node of nodes) {
        const slash = node.path.lastIndexOf('/');
        if (slash >= 0) directories.add(node.path.slice(0, slash));
        if (node.type === 'directory' && node.isExpanded) directories.add(node.path);
    }
    for (const path of directories) {
        const directory = path === rootDirectoryPath ? root : getDirectory(path);
        if (directory.available === false) return { available: false, ignoredPaths: new Set() };
        if (directory.available !== true) continue;
        for (const entry of directory.entries ?? []) {
            if (entry.gitIgnored === true) ignoredPaths.add(path ? `${path}/${entry.name}` : entry.name);
        }
    }
    return { available: true, ignoredPaths };
}
