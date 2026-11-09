import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';

/** Normalize relative separators and a leading ./ without trimming filename bytes. */
export function normalizeRelativeLocalPath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/{2,}/g, '/');
}

function collapseRepeatedSlashesPreservingUncPrefix(path: string): string {
    if (path.startsWith('//')) {
        return `//${path.slice(2).replace(/\/{2,}/g, '/')}`;
    }
    return path.replace(/^([a-z]:)\/{2,}/i, (_match, drive: string) => `${drive}/`).replace(/\/{2,}/g, '/');
}

export function normalizeLocalPathForComparison(value: string, options?: Readonly<{ preserveWhitespace?: boolean }>): string | null {
    const withForwardSlashes = (options?.preserveWhitespace ? value : value.trim()).replace(/\\/g, '/');
    const withoutBrowserExpandedDriveSlash = withForwardSlashes.replace(/^\/+([A-Za-z]:\/)/, '$1');
    const normalized = normalizeFileSystemPath(withoutBrowserExpandedDriveSlash, options);
    if (normalized && /^[a-z]:$/i.test(normalized) && /^[a-z]:\/+$/i.test(withoutBrowserExpandedDriveSlash)) return `${normalized}/`;
    return normalized ? collapseRepeatedSlashesPreservingUncPrefix(normalized) : null;
}

export function isAbsoluteLocalPath(path: string): boolean {
    return path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.startsWith('//');
}

export function resolvePathRelativeToRoot(params: Readonly<{
    path: string;
    root: string;
    /** Keep the actual entry spelling after the canonical containment comparison. */
    preservePathSpelling?: boolean;
}>): string | null {
    const path = normalizeLocalPathForComparison(params.path, { preserveWhitespace: params.preservePathSpelling === true });
    const root = normalizeLocalPathForComparison(params.root);
    if (!path || !root || !isAbsoluteLocalPath(path) || !isAbsoluteLocalPath(root)) return null;

    if (path === root) return '.';
    const prefix = root.endsWith('/') ? root : `${root}/`;
    if (!path.startsWith(prefix)) return null;
    const relative = path.slice(prefix.length);
    if (!params.preservePathSpelling) return relative;
    const segmentCount = relative.split('/').length;
    return params.path.replace(/[\\/]+$/, '').split(/[\\/]+/).slice(-segmentCount).join('/');
}

/**
 * Rebase one absolute path from an incumbent root onto another local root.
 * The comparison and output share the canonical Windows/UNC normalization, so
 * callers cannot accidentally collapse a UNC prefix or apply POSIX casing.
 */
export function rebasePathRelativeToRoot(params: Readonly<{
    path: string;
    sourceRoot: string;
    targetRoot: string;
}>): string | null {
    const relative = resolvePathRelativeToRoot({ path: params.path, root: params.sourceRoot });
    const targetRoot = normalizeLocalPathForComparison(params.targetRoot);
    if (relative === null || targetRoot === null || !isAbsoluteLocalPath(targetRoot)) return null;
    return relative === '.' ? targetRoot : `${targetRoot.endsWith('/') ? targetRoot : `${targetRoot}/`}${relative}`;
}

/** URL's standard dot-segment resolution is platform-independent; containment stays path-owner controlled. */
export function normalizeAbsoluteLocalPath(path: string): string {
    // A drive or UNC share is one filesystem root: URL dot resolution must only see its suffix.
    const root = /^(?:\/?[A-Za-z]:\/|\/\/[^/]+\/[^/]+(?:\/|$))/.exec(path)?.[0] ?? '/';
    const prefix = root.endsWith('/') ? root : `${root}/`;
    const suffix = root === '/' ? path.replace(/^\/+/, '') : path.slice(root.length);
    const encoded = suffix.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
    const normalized = decodeURIComponent(new URL(`/${encoded}`, 'https://workspace.invalid/').pathname);
    return `${prefix.replace(/^\/(?=[A-Za-z]:\/)/, '')}${normalized.slice(1)}`;
}
