import type { Href, HrefObject } from 'expo-router';

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/** Single owner for app-internal navigation destinations from persisted or remote input. */
export function normalizeInternalReturnPath(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (CONTROL_CHARACTER_PATTERN.test(trimmed) || trimmed.includes('\\')) return null;

    let decoded: string;
    try {
        decoded = decodeURIComponent(trimmed);
    } catch {
        return null;
    }

    if (CONTROL_CHARACTER_PATTERN.test(decoded) || decoded.includes('\\')) return null;
    if (decoded.includes(':')) return null;
    if (!decoded.startsWith('/')) return null;
    if (decoded.startsWith('//')) return null;
    if (decoded.includes('//')) return null;

    return decoded;
}

export function coerceRelativeRoute(raw: string): string | null {
    return normalizeInternalReturnPath(raw);
}

/** Admit a navigation path without decoding its opaque query and fragment. */
export function admitOpaqueInternalReturnPath(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const path = raw.trim();
    if (!path.startsWith('/') || CONTROL_CHARACTER_PATTERN.test(path)) return null;
    const pathname = path.split(/[?#]/, 1)[0];
    return normalizeInternalReturnPath(pathname) === null ? null : path;
}

/** Check the navigation path while preserving the opaque query, fragment and params. */
export function tryAdmitInternalRouteHref(destination: string | HrefObject): Href | null {
    const path = admitOpaqueInternalReturnPath(typeof destination === 'string' ? destination : destination.pathname);
    if (path === null) return null;
    // Approved SDK boundary: Expo dispatch accepts admitted runtime paths beyond generated route names.
    return typeof destination === 'string' ? path as Href : { ...destination, pathname: path } as Href;
}

/** Admit a runtime internal destination for callers whose route is already known to be valid. */
export function admitInternalRouteHref(destination: string | HrefObject): Href {
    const href = tryAdmitInternalRouteHref(destination);
    if (href === null) throw new Error('Invalid internal route destination');
    return href;
}

/** Preserve an admitted internal destination while qualifying its query. */
export function withInternalRouteQueryParams(
    destination: string,
    params: Readonly<Record<string, string>>,
): string {
    admitInternalRouteHref(destination);
    // The fixed base is only a URL-parser requirement; admission above forbids external paths.
    const route = new URL(destination.trim(), 'https://internal.invalid');
    for (const [key, value] of Object.entries(params)) route.searchParams.set(key, value);
    return `${route.pathname}${route.search}${route.hash}`;
}
