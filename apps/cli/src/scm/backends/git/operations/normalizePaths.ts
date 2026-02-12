import { normalizePathspec } from '../../../runtime';

export function normalizePaths(
    paths: string[],
    cwd: string
): { ok: true; normalizedPaths: string[] } | { ok: false; error: string } {
    const normalizedPaths: string[] = [];
    for (const path of paths) {
        const normalized = normalizePathspec(path, cwd);
        if (!normalized.ok) {
            return { ok: false, error: normalized.error };
        }
        normalizedPaths.push(normalized.pathspec);
    }
    return { ok: true, normalizedPaths };
}
