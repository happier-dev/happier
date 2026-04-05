import {
    findVisibleRepoWorktreeById,
    findVisibleRepoWorktreeByPath,
} from './repoWorktreeIdentity';

export type RepoWorktreeSelectionResolution = Readonly<{
    requestedRootPath: string;
    requestedWorktreeId: string | null;
    resolvedRootPath: string;
    resolvedWorktreeId: string | null;
    didRecoverMissingWorktree: boolean;
}>;

function readNonEmptyPath(rawPath: string | null | undefined, fallbackPath: string): string {
    const trimmed = String(rawPath ?? '').trim();
    return trimmed.length > 0 ? trimmed : fallbackPath;
}

export function resolveRepoWorktreeSelection(input: Readonly<{
    requestedRootPath: string | null | undefined;
    requestedWorktreeId?: string | null | undefined;
    defaultRootPath: string;
    availableWorktrees?: ReadonlyArray<Readonly<{ id?: string; path: string; isPrunable?: boolean }>> | null;
}>): RepoWorktreeSelectionResolution {
    const requestedRootPath = readNonEmptyPath(input.requestedRootPath, input.defaultRootPath);
    const requestedWorktreeId = typeof input.requestedWorktreeId === 'string' && input.requestedWorktreeId.trim().length > 0
        ? input.requestedWorktreeId.trim()
        : null;
    if (Array.isArray(input.availableWorktrees)) {
        const matchedRequestedId = findVisibleRepoWorktreeById(input.availableWorktrees, requestedWorktreeId);
        if (matchedRequestedId) {
            return {
                requestedRootPath,
                requestedWorktreeId,
                resolvedRootPath: matchedRequestedId.path,
                resolvedWorktreeId: matchedRequestedId.id ?? requestedWorktreeId,
                didRecoverMissingWorktree: false,
            };
        }
    }
    if (requestedRootPath === input.defaultRootPath && requestedWorktreeId == null) {
        return {
            requestedRootPath,
            requestedWorktreeId,
            resolvedRootPath: input.defaultRootPath,
            resolvedWorktreeId: null,
            didRecoverMissingWorktree: false,
        };
    }
    if (!Array.isArray(input.availableWorktrees)) {
        return {
            requestedRootPath,
            requestedWorktreeId,
            resolvedRootPath: requestedRootPath,
            resolvedWorktreeId: requestedWorktreeId,
            didRecoverMissingWorktree: false,
        };
    }

    const validPaths = new Set<string>([input.defaultRootPath]);
    for (const worktree of input.availableWorktrees) {
        if (worktree.isPrunable === true) {
            continue;
        }
        const path = readNonEmptyPath(worktree.path, '');
        if (path) {
            validPaths.add(path);
        }
    }

    const resolvedRootPath = validPaths.has(requestedRootPath)
        ? requestedRootPath
        : input.defaultRootPath;
    const matchedResolvedWorktree = findVisibleRepoWorktreeByPath(input.availableWorktrees, resolvedRootPath);
    const resolvedWorktreeId = resolvedRootPath === input.defaultRootPath
        ? null
        : (matchedResolvedWorktree?.id ?? requestedWorktreeId);
    const didRecoverMissingWorktree = resolvedRootPath !== requestedRootPath
        || (
            requestedWorktreeId != null
            && resolvedWorktreeId == null
            && resolvedRootPath === input.defaultRootPath
        );

    return {
        requestedRootPath,
        requestedWorktreeId,
        resolvedRootPath,
        resolvedWorktreeId,
        didRecoverMissingWorktree,
    };
}
