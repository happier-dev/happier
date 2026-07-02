import * as React from 'react';

import { listServerProfiles, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import {
    getActiveServerSnapshot,
    subscribeActiveServer,
} from '@/sync/domains/server/serverRuntime';

export type NewSessionActiveServerSource = Readonly<{
    activeServerId: string;
    serverProfiles: ReadonlyArray<ServerProfile>;
    serverProfilesSignature: string;
}>;

const emptyNewSessionActiveServerSource: NewSessionActiveServerSource = Object.freeze({
    activeServerId: '',
    serverProfiles: Object.freeze([]),
    serverProfilesSignature: '',
});

let lastNewSessionActiveServerSource: NewSessionActiveServerSource | null = null;
let lastNewSessionActiveServerSourceKey = '';

function buildServerProfilesSignature(serverProfiles: ReadonlyArray<ServerProfile>): string {
    return serverProfiles
        .map((profile) => `${profile.id}\u0000${profile.name}`)
        .join('\u0001');
}

function getNewSessionActiveServerSourceSnapshot(): NewSessionActiveServerSource {
    let activeServerId = '';
    try {
        activeServerId = getActiveServerSnapshot().serverId;
    } catch {
        activeServerId = '';
    }

    let serverProfiles: ReadonlyArray<ServerProfile> = [];
    try {
        serverProfiles = listServerProfiles().slice();
    } catch {
        serverProfiles = [];
    }

    const serverProfilesSignature = buildServerProfilesSignature(serverProfiles);
    const key = `${activeServerId}\u0002${serverProfilesSignature}`;
    if (lastNewSessionActiveServerSource && lastNewSessionActiveServerSourceKey === key) {
        return lastNewSessionActiveServerSource;
    }

    if (!activeServerId && serverProfiles.length === 0) {
        lastNewSessionActiveServerSource = emptyNewSessionActiveServerSource;
        lastNewSessionActiveServerSourceKey = key;
        return emptyNewSessionActiveServerSource;
    }

    const source: NewSessionActiveServerSource = {
        activeServerId,
        serverProfiles,
        serverProfilesSignature,
    };
    lastNewSessionActiveServerSource = source;
    lastNewSessionActiveServerSourceKey = key;
    return source;
}

export function useNewSessionActiveServerSource(): NewSessionActiveServerSource {
    return React.useSyncExternalStore(
        subscribeActiveServer,
        getNewSessionActiveServerSourceSnapshot,
        getNewSessionActiveServerSourceSnapshot,
    );
}
