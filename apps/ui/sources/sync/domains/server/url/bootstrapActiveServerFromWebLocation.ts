import { canonicalizeServerUrl, createServerUrlComparableKey } from './serverUrlCanonical';
import { consumeWebServerUrlOverrideFromLocation, getActiveServerUrl, readWebServerEntry, isActiveServerSelectionExplicit, resolveUniqueServerProfileByUrl } from '../serverProfiles';
import { setActiveServer, upsertAndActivateServer } from '../serverRuntime';

import { readWebServerUrlOverrideFromLocation, type WebServerUrlOverride } from './webServerUrlOverride';
export { readWebServerUrlOverrideFromLocation, readWebDestinationServerIdFromLocation, type WebServerUrlOverride } from './webServerUrlOverride';
export { consumeWebServerUrlOverrideFromLocation } from '../serverProfiles';

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
    consumeWebServerUrlOverrideFromLocation({ serverUrl: params.action.serverUrl, signal: params.signal, retainSelection: true });
}

/** Sign-in returns to the same entry Home even after admission cleans the browser URL. */
export function resolveWebServerEntrySignInRoute(): '/' | `/?server=${string}` {
    const entry = readWebServerEntry();
    return entry ? `/?server=${encodeURIComponent(entry.serverUrl)}` : '/';
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

export async function bootstrapActiveServerFromWebLocation(
    opts: Readonly<{ scope?: 'device' | 'tab'; activateUnknownInIsolatedRealm?: boolean }> = {},
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
        } else if (opts.activateUnknownInIsolatedRealm === true) {
            // Callers may opt in only when their realm isolates profile storage and independently
            // admits authority. The embed does both: its profile store is in-memory and its bridge
            // supplies the scoped credential after public feature discovery.
            await upsertAndActivateServer({
                serverUrl: desired,
                source: 'url',
                scope: opts.scope ?? 'device',
            });
        }
    }

    return { serverUrl: desired, cleanedRelativeUrl: override.cleanedRelativeUrl };
}
