import { switchConnectionToActiveServer } from '../../runtime/orchestration/connectionManager';
import { getActiveServerSnapshot, setActiveServer, upsertAndActivateServer } from './serverRuntime';
import { getDeviceDefaultServerId, getTabActiveServerId } from './serverProfiles';
import type { ServerProfileSource } from './serverProfiles';
import { canonicalizeServerUrl, createServerUrlComparableKey } from './url/serverUrlCanonical';

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
    const leftKey = createServerUrlComparableKey(left);
    if (!leftKey) return false;
    return leftKey === createServerUrlComparableKey(right);
}

function canSkipActiveServerUrlSwitch(params: Readonly<{
    activeServerUrl: string;
    targetServerUrl: string;
    scope: 'device' | 'tab';
}>): boolean {
    if (!isSameServerUrl(params.activeServerUrl, params.targetServerUrl)) return false;
    if (params.scope === 'tab') return true;
    return !getTabActiveServerId();
}

function canSkipActiveServerIdSwitch(params: Readonly<{
    activeServerId: string;
    targetServerId: string;
    scope: 'device' | 'tab';
}>): boolean {
    if (params.activeServerId !== params.targetServerId) return false;
    if (params.scope === 'tab') return true;
    return !getTabActiveServerId() && getDeviceDefaultServerId() === params.targetServerId;
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
    const scope = params.scope ?? 'device';
    if (canSkipActiveServerUrlSwitch({ activeServerUrl: active.serverUrl, targetServerUrl, scope })) return false;

    upsertAndActivateServer({
        serverUrl: targetServerUrl,
        name: params.name ?? defaultServerNameFromUrl(targetServerUrl),
        source: params.source ?? 'url',
        scope,
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
    const scope = params.scope ?? 'device';
    if (canSkipActiveServerIdSwitch({ activeServerId: active.serverId, targetServerId, scope })) return false;

    setActiveServer({
        serverId: targetServerId,
        scope,
    });
    await switchConnectionToActiveServer();
    if (params.refreshAuth) {
        await params.refreshAuth();
    }
    return true;
}
