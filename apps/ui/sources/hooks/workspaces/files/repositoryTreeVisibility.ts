/** Project is a projection of the complete host listing; unknown entries stay visible. */
export function projectRepositoryTreeNodes<T extends { path: string; type: string; depth: number }>(
    nodes: readonly T[], ignoredPaths: ReadonlySet<string>, preservedPaths: readonly string[],
): readonly T[] {
    if (ignoredPaths.size === 0) return nodes;
    const preserved = new Set<string>();
    for (const path of preservedPaths) {
        const parts = path.split('/');
        while (parts.length > 0) {
            preserved.add(parts.join('/'));
            parts.pop();
        }
    }
    let hiddenDepth: number | null = null;
    return nodes.filter((node) => {
        if (hiddenDepth !== null) {
            if (node.depth > hiddenDepth) return false;
            hiddenDepth = null;
        }
        if (!ignoredPaths.has(node.path) || preserved.has(node.path)) return true;
        if (node.type === 'directory') hiddenDepth = node.depth;
        return false;
    });
}
