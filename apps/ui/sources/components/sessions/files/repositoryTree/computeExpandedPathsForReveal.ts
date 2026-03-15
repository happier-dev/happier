export type ComputeExpandedPathsForRevealInput = Readonly<{
    expandedPaths: readonly string[];
    fullPath: string;
}>;

function normalizePathSegment(input: string): string {
    return input.trim().replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function listDirectoryAncestors(fullPath: string): string[] {
    const normalized = normalizePathSegment(fullPath);
    if (!normalized) return [];
    const parts = normalized.split('/').filter((part) => part && part !== '.');
    if (parts.length < 2) return [];
    const dirs = parts.slice(0, -1);

    const out: string[] = [];
    for (let i = 0; i < dirs.length; i++) {
        out.push(dirs.slice(0, i + 1).join('/'));
    }
    return out;
}

export function computeExpandedPathsForReveal(input: ComputeExpandedPathsForRevealInput): string[] {
    const existing = input.expandedPaths
        .map((path) => normalizePathSegment(path))
        .filter(Boolean);

    const seen = new Set(existing);
    const out = [...existing];

    for (const ancestor of listDirectoryAncestors(input.fullPath)) {
        if (seen.has(ancestor)) continue;
        seen.add(ancestor);
        out.push(ancestor);
    }

    return out;
}
