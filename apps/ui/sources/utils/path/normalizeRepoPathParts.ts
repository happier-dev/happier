export type RepoPathParts = Readonly<{
    dir: string | null;
    name: string;
}>;

function normalizeDir(input: string): string {
    return input.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function normalizePathLike(input: string): string {
    return input.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

export function normalizeRepoPathParts(input: Readonly<{
    fileName?: string | null;
    filePath?: string | null;
    fullPath?: string | null;
}>): RepoPathParts {
    const rawDir = typeof input.filePath === 'string' ? input.filePath : '';
    const fallbackDir = normalizeDir(rawDir);

    const candidatePath = (() => {
        if (typeof input.fullPath === 'string' && input.fullPath.trim()) return input.fullPath;
        if (typeof input.fileName === 'string' && input.fileName.trim()) return input.fileName;
        return '';
    })();

    const cleanCandidatePath = normalizePathLike(candidatePath);
    const segments = cleanCandidatePath.split('/').filter(Boolean);
    const name = segments.at(-1) ?? '';
    const dirFromCandidate = segments.length > 1 ? segments.slice(0, -1).join('/') : '';

    const dir = dirFromCandidate || fallbackDir;
    return {
        dir: dir ? dir : null,
        name,
    };
}
