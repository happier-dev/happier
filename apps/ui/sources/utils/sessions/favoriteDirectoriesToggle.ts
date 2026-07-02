import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';

export function resolveDirectoryFavoriteComparisonKey(
    path: string,
    homeDir: string | null | undefined,
): string {
    const resolvedPath = resolveAbsolutePath(path, homeDir || undefined);
    return normalizeFileSystemPath(resolvedPath) ?? resolvedPath;
}

export function normalizeDirectoryFavoritePaths(
    storedFavorites: ReadonlyArray<unknown> | null | undefined,
    homeDir: string | null | undefined,
): ReadonlyArray<string> {
    const sanitized = Array.isArray(storedFavorites)
        ? storedFavorites.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : [];
    const seenKeys = new Set<string>();
    const normalized: string[] = [];
    for (const entry of sanitized) {
        const key = resolveDirectoryFavoriteComparisonKey(entry, homeDir);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        normalized.push(entry);
    }
    return normalized;
}

export function toggleHomeAwareDirectoryFavorite(
    storedFavorites: ReadonlyArray<unknown> | null | undefined,
    target: string,
    homeDir: string | null | undefined,
): ReadonlyArray<string> {
    const targetKey = resolveDirectoryFavoriteComparisonKey(target, homeDir);
    const sanitized = normalizeDirectoryFavoritePaths(storedFavorites, homeDir);

    const hasFavorite = sanitized.some(
        (entry) => resolveDirectoryFavoriteComparisonKey(entry, homeDir) === targetKey,
    );

    if (!hasFavorite) {
        return [...sanitized, target];
    }

    return sanitized.filter(
        (entry) => resolveDirectoryFavoriteComparisonKey(entry, homeDir) !== targetKey,
    );
}
