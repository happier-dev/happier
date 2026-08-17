import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';

function collapseRepeatedSlashesPreservingUncPrefix(path: string): string {
    if (path.startsWith('//')) {
        return `//${path.slice(2).replace(/\/{2,}/g, '/')}`;
    }
    return path.replace(/^([a-z]:)\/{2,}/i, (_match, drive: string) => `${drive}/`).replace(/\/{2,}/g, '/');
}

export function normalizeLocalPathForComparison(value: string): string | null {
    const withForwardSlashes = value.trim().replace(/\\/g, '/');
    const withoutBrowserExpandedDriveSlash = withForwardSlashes.replace(/^\/+([A-Za-z]:\/)/, '$1');
    const normalized = normalizeFileSystemPath(withoutBrowserExpandedDriveSlash);
    return normalized ? collapseRepeatedSlashesPreservingUncPrefix(normalized) : null;
}

export function isAbsoluteLocalPath(path: string): boolean {
    return path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.startsWith('//');
}

export function resolvePathRelativeToRoot(params: Readonly<{
    path: string;
    root: string;
}>): string | null {
    const path = normalizeLocalPathForComparison(params.path);
    const root = normalizeLocalPathForComparison(params.root);
    if (!path || !root || !isAbsoluteLocalPath(path) || !isAbsoluteLocalPath(root)) return null;

    if (path === root) return '.';
    const prefix = root === '/' ? '/' : `${root}/`;
    if (!path.startsWith(prefix)) return null;
    return root === '/' ? path.slice(1) : path.slice(root.length + 1);
}
