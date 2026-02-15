import { switchConnectionToActiveServer } from '../../runtime/orchestration/connectionManager';
import { getActiveServerSnapshot, setActiveServer, upsertAndActivateServer } from './serverRuntime';
import type { ServerProfileSource } from './serverProfiles';
import { canonicalizeServerUrl } from './url/serverUrlCanonical';

export function normalizeServerUrl(raw: string): string {
    return canonicalizeServerUrl(raw);
}

export function defaultServerNameFromUrl(rawUrl: string): string {
    const url = normalizeServerUrl(rawUrl);
    try {
        const parsed = new URL(url);
        if (!parsed.hostname) return url;
        return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    } catch {
        return url;
    }
}

export function isSameServerUrl(left: string, right: string): boolean {
    return normalizeServerUrl(left) === normalizeServerUrl(right);
}

export async function upsertActivateAndSwitchServer(params: Readonly<{
    serverUrl: string;
    source?: ServerProfileSource;
    scope?: 'device' | 'tab';
    name?: string;
    refreshAuth?: (() => Promise<void>) | null;
}>): Promise<boolean> {
    const targetServerUrl = normalizeServerUrl(params.serverUrl);
    if (!targetServerUrl) return false;

    const active = getActiveServerSnapshot();
    if (isSameServerUrl(active.serverUrl, targetServerUrl)) return false;

    upsertAndActivateServer({
        serverUrl: targetServerUrl,
        name: params.name ?? defaultServerNameFromUrl(targetServerUrl),
        source: params.source ?? 'url',
        scope: params.scope ?? 'device',
    });
    await switchConnectionToActiveServer();
    if (params.refreshAuth) {
        await params.refreshAuth();
    }
    return true;
}

export async function setActiveServerAndSwitch(params: Readonly<{
    serverId: string;
    scope?: 'device' | 'tab';
    refreshAuth?: (() => Promise<void>) | null;
}>): Promise<boolean> {
    const targetServerId = String(params.serverId ?? '').trim();
    if (!targetServerId) return false;

    const active = getActiveServerSnapshot();
    if (active.serverId === targetServerId) return false;

    setActiveServer({
        serverId: targetServerId,
        scope: params.scope ?? 'device',
    });
    await switchConnectionToActiveServer();
    if (params.refreshAuth) {
        await params.refreshAuth();
    }
    return true;
}
