import { canonicalizeServerUrl, createServerUrlComparableKey } from './serverUrlCanonical';
import { getActiveServerUrl, getTabActiveServerId } from '../serverProfiles';
import { upsertAndActivateServer } from '../serverRuntime';

export type WebServerUrlOverride = Readonly<{ serverUrl: string; cleanedRelativeUrl: string }>;

function isWebRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function normalizeServerUrl(raw: string): string | null {
    const normalized = canonicalizeServerUrl(String(raw ?? ''));
    return normalized ? normalized : null;
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

function replaceCurrentWebLocation(relativeUrl: string): void {
    if (!isWebRuntime()) return;
    try {
        window.history.replaceState(null, '', relativeUrl);
    } catch {
        // ignore
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

        const serverUrl = normalizeServerUrl(rawServer) || (legacyAutoEnabled ? normalizeServerUrl(rawLegacyUrl) : null);
        if (!serverUrl) return null;

        current.searchParams.delete('server');
        current.searchParams.delete('url');
        current.searchParams.delete('auto');
        current.searchParams.delete('serverId');
        const search = current.searchParams.toString();
        const cleanedRelativeUrl = `${current.pathname}${search ? `?${search}` : ''}${current.hash ?? ''}`;
        return { serverUrl, cleanedRelativeUrl };
    } catch {
        return null;
    }
}

export function bootstrapActiveServerFromWebLocation(
    opts: Readonly<{ scope?: 'device' | 'tab' }> = {},
): WebServerUrlOverride | null {
    const override = readWebServerUrlOverrideFromLocation();
    if (!override) return null;

    const desired = normalizeServerUrl(override.serverUrl);
    if (!desired) return null;

    const current = normalizeServerUrl(getActiveServerUrl() ?? '');
    const currentKey = createServerUrlComparableKey(current ?? '');
    const desiredKey = createServerUrlComparableKey(desired);
    if (!currentKey || !desiredKey || currentKey !== desiredKey || getTabActiveServerId()) {
        try {
            upsertAndActivateServer({
                serverUrl: desired,
                source: 'url',
                scope: opts.scope ?? 'device',
            });
        } catch {
            // ignore
        }
    }

    replaceCurrentWebLocation(override.cleanedRelativeUrl);
    return { serverUrl: desired, cleanedRelativeUrl: override.cleanedRelativeUrl };
}
