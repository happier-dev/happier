import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';

export function resolveDirectoryFavoriteComparisonKey(
    path: string,
    homeDir: string | null | undefined,
): string {
    const resolvedPath = resolveAbsolutePath(path, homeDir || undefined);
    return normalizeFileSystemPath(resolvedPath) ?? resolvedPath;
}

export function toggleHomeAwareDirectoryFavorite(
    storedFavorites: ReadonlyArray<unknown> | null | undefined,
    target: string,
    homeDir: string | null | undefined,
): ReadonlyArray<string> {
    const targetKey = resolveDirectoryFavoriteComparisonKey(target, homeDir);
    const sanitized = Array.isArray(storedFavorites)
        ? storedFavorites.filter((entry): entry is string => typeof entry === 'string')
        : [];

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
