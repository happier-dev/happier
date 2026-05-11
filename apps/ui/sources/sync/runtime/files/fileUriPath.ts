export function joinFileUri(baseUri: string, childPath: string): string {
    const base = String(baseUri ?? '').trim();
    const child = String(childPath ?? '').trim().replace(/^\/+/g, '');
    if (!base) return child;
    if (!child) return base;
    const withSlash = base.endsWith('/') ? base : `${base}/`;
    return `${withSlash}${child}`;
}

export function sanitizeFileUriSegment(value: string, fallback: string): string {
    const normalized = String(value ?? '')
        .trim()
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean)
        .at(-1)
        ?.replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return normalized && normalized.length > 0 ? normalized : fallback;
}
