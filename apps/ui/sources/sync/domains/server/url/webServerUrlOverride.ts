import { canonicalizeServerUrl } from './serverUrlCanonical';

export type WebServerUrlOverride = Readonly<{ serverUrl: string; cleanedRelativeUrl: string }>;

function isWebRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function normalizePathname(raw: string): string {
    const pathname = String(raw ?? '').trim() || '/';
    const withSlash = pathname.startsWith('/') ? pathname : `/${pathname}`;
    return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
}

function isRouteOwnedServerParam(pathname: string): boolean {
    const normalized = normalizePathname(pathname);
    return normalized === '/terminal' || normalized === '/terminal/connect';
}

/** Destination scope is a boot hint, not a global Home override during navigation. */
export function readWebDestinationServerIdFromLocation(): string | null {
    if (!isWebRuntime() || typeof window.location?.href !== 'string') return null;
    try {
        const current = new URL(window.location.href);
        if (isRouteOwnedServerParam(current.pathname)) return null;
        return current.searchParams.get('serverId')?.trim() || null;
    } catch {
        return null;
    }
}

export function readWebServerUrlOverrideFromLocation(): WebServerUrlOverride | null {
    if (!isWebRuntime()) return null;
    if (typeof window.location?.href !== 'string') return null;

    try {
        const current = new URL(window.location.href);
        if (isRouteOwnedServerParam(current.pathname)) return null;

        const rawServer = (current.searchParams.get('server') ?? '').trim();
        const rawLegacyUrl = (current.searchParams.get('url') ?? '').trim();
        const rawLegacyAuto = (current.searchParams.get('auto') ?? '').trim().toLowerCase();
        const legacyAutoEnabled = rawLegacyAuto === '1' || rawLegacyAuto === 'true' || rawLegacyAuto === 'yes' || rawLegacyAuto === 'on';

        const serverUrl = canonicalizeServerUrl(rawServer) || (legacyAutoEnabled ? canonicalizeServerUrl(rawLegacyUrl) : null);
        if (!serverUrl) return null;

        current.searchParams.delete('server');
        current.searchParams.delete('url');
        current.searchParams.delete('auto');
        // serverId qualifies the destination, independently of this global Home selection.
        const search = current.searchParams.toString();
        const cleanedRelativeUrl = `${current.pathname}${search ? `?${search}` : ''}${current.hash ?? ''}`;
        return { serverUrl, cleanedRelativeUrl };
    } catch {
        return null;
    }
}
