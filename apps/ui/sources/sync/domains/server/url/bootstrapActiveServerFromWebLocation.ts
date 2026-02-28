import { canonicalizeServerUrl } from './serverUrlCanonical';
import { getActiveServerUrl } from '../serverProfiles';
import { upsertAndActivateServer } from '../serverRuntime';

export type WebServerUrlOverride = Readonly<{ serverUrl: string; cleanedRelativeUrl: string }>;

function isWebRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function normalizeServerUrl(raw: string): string | null {
    const normalized = canonicalizeServerUrl(String(raw ?? ''));
    return normalized ? normalized : null;
}

export function readWebServerUrlOverrideFromLocation(): WebServerUrlOverride | null {
    if (!isWebRuntime()) return null;
    if (typeof window.location?.href !== 'string') return null;

    try {
        const current = new URL(window.location.href);
        const rawServer = (current.searchParams.get('server') ?? '').trim();
        const rawLegacyUrl = (current.searchParams.get('url') ?? '').trim();
        const rawLegacyAuto = (current.searchParams.get('auto') ?? '').trim().toLowerCase();
        const legacyAutoEnabled = rawLegacyAuto === '1' || rawLegacyAuto === 'true' || rawLegacyAuto === 'yes' || rawLegacyAuto === 'on';

        const serverUrl = normalizeServerUrl(rawServer) || (legacyAutoEnabled ? normalizeServerUrl(rawLegacyUrl) : null);
        if (!serverUrl) return null;

        current.searchParams.delete('server');
        current.searchParams.delete('url');
        current.searchParams.delete('auto');
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
    if (current !== desired) {
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

    return { serverUrl: desired, cleanedRelativeUrl: override.cleanedRelativeUrl };
}
