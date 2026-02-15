import {
    getActiveServerSnapshot as getSnapshotFromProfiles,
    setActiveServerId,
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
    }>,
): ServerProfile {
    const profile = upsertServerProfile({
        serverUrl: params.serverUrl,
        name: params.name,
        source: params.source,
    });
    setActiveServerId(profile.id, { scope: params.scope ?? 'device' });
    return profile;
}
