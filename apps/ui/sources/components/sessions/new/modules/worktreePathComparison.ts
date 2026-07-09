import { normalizeMachineFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';

/**
 * Canonicalize a path for new-session worktree comparison. Handles:
 *  - tilde expansion against an optional machine home directory (`~/foo` -> `/Users/leeroy/foo`)
 *  - separator normalization (`\\` -> `/`)
 *  - Windows drive-letter + UNC case-insensitivity
 *  - trailing-separator stripping
 *
 * Returns `null` for empty / non-string input so callers can short-circuit.
 */
export function canonicalizeWorktreePath(
    path: string | null | undefined,
    machineHomeDir: string | null | undefined,
    machinePlatform?: string | null | undefined,
): string | null {
    if (typeof path !== 'string' || path.length === 0) return null;
    const expanded = machineHomeDir ? resolveAbsolutePath(path, machineHomeDir) : path;
    return normalizeMachineFileSystemPath(expanded, { platform: machinePlatform ?? null });
}

export function pathsAreSameWorktree(
    a: string | null | undefined,
    b: string | null | undefined,
    machineHomeDir: string | null | undefined,
    machinePlatform?: string | null | undefined,
): boolean {
    const left = canonicalizeWorktreePath(a, machineHomeDir, machinePlatform);
    const right = canonicalizeWorktreePath(b, machineHomeDir, machinePlatform);
    if (left === null || right === null) return false;
    return left === right;
}

function pathIsAtOrInsideRoot(candidate: string, root: string): boolean {
    return candidate === root || candidate.startsWith(`${root}/`);
}

/**
 * True when `candidatePath` belongs to the SAME repository described by
 * `repoRootPath` + `worktreePaths`: it is the repo root, sits within it, or is
 * sits within one of the repo's worktrees (all compared canonically, with
 * sibling-prefix collisions like `/repo` vs `/repo-2` guarded by requiring a
 * separator after the root).
 *
 * `git worktree list` is repo-wide, so switching the selected path among
 * siblings of the same repo yields an identical worktree list. Callers use this
 * to preserve an already-hydrated SCM snapshot across such switches instead of
 * flashing the worktree list empty during the new path's refetch.
 */
export function pathBelongsToRepo(params: Readonly<{
    candidatePath: string | null | undefined;
    repoRootPath: string | null | undefined;
    worktreePaths: ReadonlyArray<string | null | undefined>;
    machineHomeDir?: string | null;
    machinePlatform?: string | null;
}>): boolean {
    const homeDir = params.machineHomeDir ?? null;
    const platform = params.machinePlatform ?? null;
    const candidate = canonicalizeWorktreePath(params.candidatePath, homeDir, platform);
    if (candidate === null) return false;

    const root = canonicalizeWorktreePath(params.repoRootPath, homeDir, platform);
    if (root !== null && pathIsAtOrInsideRoot(candidate, root)) {
        return true;
    }

    return params.worktreePaths.some((worktreePath) => {
        const worktreeRoot = canonicalizeWorktreePath(worktreePath, homeDir, platform);
        return worktreeRoot !== null && pathIsAtOrInsideRoot(candidate, worktreeRoot);
    });
}
