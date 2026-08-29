import {
    clearTabActiveServerId,
    getDeviceDefaultServerId,
    getTabActiveServerId,
    getActiveServerSnapshot as getSnapshotFromProfiles,
    isActiveServerSelectionExplicit as isExplicitFromProfiles,
    setActiveServerId,
    setServerProfileShareableUrl as setServerProfileShareableUrlFromProfiles,
    subscribeActiveServer as subscribeFromProfiles,
    upsertServerProfile,
    type ActiveServerSnapshot,
    type ServerProfile,
} from './serverProfiles';

export type { ActiveServerSnapshot } from './serverProfiles';
export type { AccountServiceEndpointV1 } from './serverProfiles';
export {
    updateActiveServerRuntimeOrigin,
    subscribeActiveServerRuntimeOrigin,
    getAccountServiceEndpointSnapshot,
    setAccountServiceEndpoint,
    subscribeAccountServiceEndpoint,
    resetAccountServiceToDefault,
} from './serverProfiles';

export function getActiveServerSnapshot(): ActiveServerSnapshot {
    return getSnapshotFromProfiles();
}

export function subscribeActiveServer(listener: (snapshot: ActiveServerSnapshot) => void): () => void {
    return subscribeFromProfiles(listener);
}

export function isActiveServerSelectionExplicit(): boolean {
    return isExplicitFromProfiles();
}

export function setActiveServer(params: Readonly<{ serverId: string; scope?: 'device' | 'tab' }>): void {
    const scope = params.scope ?? 'device';
    const serverId = String(params.serverId ?? '').trim();
    setActiveServerId(serverId, { scope });
    if (scope === 'device' && getTabActiveServerId() && getDeviceDefaultServerId() === serverId) {
        clearTabActiveServerId();
    }
}

export function upsertAndActivateServer(
    params: Readonly<{
        serverUrl: string;
        name?: string;
        source?: ServerProfile['source'];
        scope?: 'device' | 'tab';
        replaceEquivalentStoredUrl?: boolean;
    }>,
): ServerProfile {
    const profile = upsertServerProfile({
        serverUrl: params.serverUrl,
        name: params.name,
        source: params.source,
        replaceEquivalentStoredUrl: params.replaceEquivalentStoredUrl,
    });
    setActiveServer({ serverId: profile.id, scope: params.scope ?? 'device' });
    return profile;
}

export function upsertServerProfileOnly(
    params: Readonly<{
        serverUrl: string;
        name?: string;
        source?: ServerProfile['source'];
        replaceEquivalentStoredUrl?: boolean;
    }>,
): ServerProfile {
    return upsertServerProfile({
        serverUrl: params.serverUrl,
        name: params.name,
        source: params.source,
        replaceEquivalentStoredUrl: params.replaceEquivalentStoredUrl,
    });
}

export function setServerProfileShareableUrl(
    serverProfileId: string,
    serverUrl: string | null | undefined,
    options: Readonly<{ validatedAgainstServerUrl?: string | null | undefined }> = {},
): void {
    setServerProfileShareableUrlFromProfiles(serverProfileId, serverUrl, options);
}

export function setActiveShareableServerUrl(
    serverUrl: string | null | undefined,
    options: Readonly<{ validatedAgainstServerUrl?: string | null | undefined }> = {},
): void {
    const snapshot = getSnapshotFromProfiles();
    const serverId = String(snapshot.serverId ?? '').trim();
    if (!serverId) return;
    setServerProfileShareableUrlFromProfiles(serverId, serverUrl, options);
}
