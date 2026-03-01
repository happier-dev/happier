export function isSafeWorkspaceRelativePath(raw: string): boolean {
    if (!raw) return false;
    const value = raw.trim();
    if (!value) return false;
    if (value.includes('\0')) return false;
    if (value.includes('\\')) return false; // keep paths normalized to posix in UI
    if (value.startsWith('/') || value.startsWith('~')) return false; // absolute-ish paths
    if (/^[A-Za-z]:/.test(value)) return false; // windows drive paths
    if (value.startsWith('./') || value.startsWith('../')) return false; // explicit traversal/relative prefixes
    if (value.includes('//')) return false; // avoid ambiguous path collapsing

    const segments = value.split('/').filter(Boolean);
    if (segments.some((seg) => seg === '.' || seg === '..')) return false;

    return true;
}
