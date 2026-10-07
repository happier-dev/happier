import { canonicalizeServerUrl, createServerUrlComparableKey } from './serverUrlCanonical';
import { getActiveServerUrl, isActiveServerSelectionExplicit, resolveUniqueServerProfileByUrl } from '../serverProfiles';
import { setActiveServer, upsertAndActivateServer } from '../serverRuntime';

export type WebServerUrlOverride = Readonly<{ serverUrl: string; cleanedRelativeUrl: string }>;

export type WebServerUrlOverrideAction = Readonly<{
    kind: 'cleanup_only' | 'refresh_auth' | 'switch_server';
    serverUrl: string;
}>;

export async function commitWebServerUrlOverride(params: Readonly<{
    action: WebServerUrlOverrideAction;
    switchServer: (params: Readonly<{
        serverUrl: string;
        refreshAuth: () => Promise<void>;
    }>) => Promise<void>;
    refreshAuth: () => Promise<void>;
    signal?: AbortSignal;
}>): Promise<void> {
    if (params.action.kind === 'switch_server') {
        await params.switchServer({
            serverUrl: params.action.serverUrl,
            refreshAuth: params.refreshAuth,
        });
    } else if (params.action.kind === 'refresh_auth') {
        await params.refreshAuth();
    }
    consumeWebServerUrlOverrideFromLocation({ serverUrl: params.action.serverUrl, signal: params.signal });
}

function isWebRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function normalizeServerUrl(raw: string): string | null {
    const normalized = canonicalizeServerUrl(String(raw ?? ''));
    return normalized ? normalized : null;
}

function normalizeHostname(rawUrl: string | null | undefined): string {
    try {
        const hostname = new URL(String(rawUrl ?? '')).hostname.trim().toLowerCase().replace(/\.$/, '');
        if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1);
        return hostname;
    } catch {
        return '';
    }
}

function isGenericLoopbackHostname(hostname: string): boolean {
    return hostname === 'localhost'
        || hostname === '127.0.0.1'
        || hostname === '0.0.0.0'
        || hostname === '::1';
}

function isNamedLocalhostHostname(hostname: string): boolean {
    return hostname.endsWith('.localhost') && hostname !== 'localhost';
}

function shouldReplaceEquivalentStoredUrl(current: string | null, desired: string): boolean {
    if (!current || current === desired) return false;
    return isGenericLoopbackHostname(normalizeHostname(current))
        && isNamedLocalhostHostname(normalizeHostname(desired));
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

/** Consume only the admitted Home still present at the current browser destination. */
export function consumeWebServerUrlOverrideFromLocation(params: Readonly<{
    serverUrl: string;
    signal?: AbortSignal;
}>): void {
    if (params.signal?.aborted) return;
    const current = readWebServerUrlOverrideFromLocation();
    if (current?.serverUrl !== params.serverUrl) return;
    window.history.replaceState(window.history.state, '', current.cleanedRelativeUrl);
}

export async function bootstrapActiveServerFromWebLocation(
    opts: Readonly<{ scope?: 'device' | 'tab' }> = {},
): Promise<WebServerUrlOverride | null> {
    const override = readWebServerUrlOverrideFromLocation();
    if (!override) return null;

    const desired = normalizeServerUrl(override.serverUrl);
    if (!desired) return null;

    const current = normalizeServerUrl(getActiveServerUrl() ?? '');
    const currentKey = createServerUrlComparableKey(current ?? '');
    const desiredKey = createServerUrlComparableKey(desired);
    const replaceEquivalentStoredUrl = Boolean(
        currentKey
        && desiredKey
        && currentKey === desiredKey
        && shouldReplaceEquivalentStoredUrl(current, desired),
    );
    if (replaceEquivalentStoredUrl) {
        try {
            await upsertAndActivateServer({
                serverUrl: desired,
                scope: opts.scope ?? 'device',
                replaceEquivalentStoredUrl: true,
            });
        } catch {
            // ignore
        }
    } else if (desiredKey && (currentKey !== desiredKey || !isActiveServerSelectionExplicit())) {
        const saved = resolveUniqueServerProfileByUrl(desired);
        if (saved) {
            try {
                await setActiveServer({ serverId: saved.id, scope: opts.scope ?? 'device' });
            } catch {
                // The URL intent remains for the mounted flow to handle.
            }
        }
    }

    return { serverUrl: desired, cleanedRelativeUrl: override.cleanedRelativeUrl };
}
