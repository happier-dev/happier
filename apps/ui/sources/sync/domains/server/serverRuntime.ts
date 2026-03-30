import {
    getActiveServerSnapshot as getSnapshotFromProfiles,
    setActiveServerId,
    setServerProfileShareableUrl,
    subscribeActiveServer as subscribeFromProfiles,
    upsertServerProfile,
    type ActiveServerSnapshot,
    type ServerProfile,
} from './serverProfiles';

export type { ActiveServerSnapshot } from './serverProfiles';

export function getActiveServerSnapshot(): ActiveServerSnapshot {
    return getSnapshotFromProfiles();
}

export function subscribeActiveServer(listener: (snapshot: ActiveServerSnapshot) => void): () => void {
    return subscribeFromProfiles(listener);
}

export function setActiveServer(params: Readonly<{ serverId: string; scope?: 'device' | 'tab' }>): void {
    setActiveServerId(params.serverId, { scope: params.scope ?? 'device' });
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
    setActiveServerId(profile.id, { scope: params.scope ?? 'device' });
    return profile;
}

export function setActiveShareableServerUrl(serverUrl: string | null | undefined): void {
    const snapshot = getSnapshotFromProfiles();
    const serverId = String(snapshot.serverId ?? '').trim();
    if (!serverId) return;
    setServerProfileShareableUrl(serverId, serverUrl);
}
