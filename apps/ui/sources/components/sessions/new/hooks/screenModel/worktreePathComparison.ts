import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';

/**
 * Canonicalize a path for "is this the same worktree?" comparison. Handles:
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
): string | null {
    if (typeof path !== 'string' || path.length === 0) return null;
    const expanded = machineHomeDir ? resolveAbsolutePath(path, machineHomeDir) : path;
    return normalizeFileSystemPath(expanded);
}

export function pathsAreSameWorktree(
    a: string | null | undefined,
    b: string | null | undefined,
    machineHomeDir: string | null | undefined,
): boolean {
    const left = canonicalizeWorktreePath(a, machineHomeDir);
    const right = canonicalizeWorktreePath(b, machineHomeDir);
    if (left === null || right === null) return false;
    return left === right;
}
