import {
    activateServerProfileIfSelectionImplicit as activateIfImplicitFromProfiles,
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
export type { ActiveServerRuntimeTarget } from './serverProfiles';
export type { AccountServiceEndpointV1 } from './serverProfiles';
export {
    areServerProfileIdentifiersEquivalent,
    captureActiveServerRuntimeTarget,
    getActiveServerHomeCarrier,
    readActiveHomeTransport,
    publishActiveServerRuntimeOrigin,
    releaseActiveServerRuntimeOrigin,
    subscribeActiveServerRuntimeOrigin,
    getAccountServiceEndpointSnapshot,
    setAccountServiceEndpoint,
    subscribeAccountServiceEndpoint,
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

export async function activateServerProfileIfSelectionImplicit(serverId: string): Promise<boolean> {
    return await activateIfImplicitFromProfiles(serverId);
}

export async function setActiveServer(params: Readonly<{ serverId: string; scope?: 'device' | 'tab' }>): Promise<void> {
    const scope = params.scope ?? 'device';
    const serverId = String(params.serverId ?? '').trim();
    await setActiveServerId(serverId, { scope });
    if (scope === 'device' && getTabActiveServerId() && getDeviceDefaultServerId() === serverId) {
        clearTabActiveServerId();
    }
}

export async function upsertAndActivateServer(
    params: Readonly<{
        serverUrl: string;
        name?: string;
        source?: ServerProfile['source'];
        scope?: 'device' | 'tab';
        replaceEquivalentStoredUrl?: boolean;
    }>,
): Promise<ServerProfile> {
    const profile = await upsertServerProfile({
        serverUrl: params.serverUrl,
        name: params.name,
        source: params.source,
        replaceEquivalentStoredUrl: params.replaceEquivalentStoredUrl,
    });
    await setActiveServer({ serverId: profile.id, scope: params.scope ?? 'device' });
    return profile;
}

export async function upsertServerProfileOnly(
    params: Readonly<{
        serverUrl: string;
        name?: string;
        source?: ServerProfile['source'];
        replaceEquivalentStoredUrl?: boolean;
    }>,
): Promise<ServerProfile> {
    return await upsertServerProfile({
        serverUrl: params.serverUrl,
        name: params.name,
        source: params.source,
        replaceEquivalentStoredUrl: params.replaceEquivalentStoredUrl,
    });
}

export async function setServerProfileShareableUrl(
    serverProfileId: string,
    serverUrl: string | null | undefined,
    options: Readonly<{ validatedAgainstServerUrl?: string | null | undefined }> = {},
): Promise<void> {
    await setServerProfileShareableUrlFromProfiles(serverProfileId, serverUrl, options);
}

export async function setActiveShareableServerUrl(
    serverUrl: string | null | undefined,
    options: Readonly<{ validatedAgainstServerUrl?: string | null | undefined }> = {},
): Promise<void> {
    const snapshot = getSnapshotFromProfiles();
    const serverId = String(snapshot.serverId ?? '').trim();
    if (!serverId) return;
    await setServerProfileShareableUrlFromProfiles(serverId, serverUrl, options);
}
