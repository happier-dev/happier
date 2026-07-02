import * as React from 'react';

import { useSetting } from '@/sync/domains/state/storage';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import {
    listServerProfileScopeIds,
    normalizeServerSelectionSettingsForProfileScopeIds,
} from '@/sync/domains/server/selection/serverSelectionProfileScopeIds';
import {
    getActiveServerSnapshot,
    subscribeActiveServer,
} from '@/sync/domains/server/serverRuntime';
import {
    getEffectiveServerSelectionFromRawSettings,
    resolveActiveServerSelectionFromRawSettings,
} from '@/sync/domains/server/selection/serverSelectionResolution';
import type {
    EffectiveServerSelection,
    ResolvedActiveServerSelection,
} from '@/sync/domains/server/selection/serverSelectionTypes';
import { useServerProfilesGeneration } from './useServerProfilesGeneration';

type ActiveServerSelectionSource = Readonly<{
    activeServerId: string;
    availableServerIds: ReadonlyArray<string>;
    serverProfiles: ReadonlyArray<ReturnType<typeof listServerProfiles>[number]>;
}>;

const emptyActiveServerSelectionSource: ActiveServerSelectionSource = Object.freeze({
    activeServerId: '',
    availableServerIds: Object.freeze([]),
    serverProfiles: Object.freeze([]),
});

let lastActiveServerSelectionSource: ActiveServerSelectionSource | null = null;
let lastActiveServerSelectionSourceKey = '';

function getActiveServerSelectionSourceSnapshot(): ActiveServerSelectionSource {
    let activeServerId = '';
    try {
        activeServerId = getActiveServerSnapshot().serverId;
    } catch {
        activeServerId = '';
    }

    const serverProfiles = listServerProfiles();
    const availableServerIds = listServerProfileScopeIds(serverProfiles);
    const profileKey = serverProfiles
        .map((profile) => `${profile.id}\u0001${profile.serverIdentityId ?? ''}\u0001${(profile.legacyServerIds ?? []).join('\u0002')}`)
        .join('\u0000');
    const key = `${activeServerId}\u0000${availableServerIds.join('\u0000')}\u0000${profileKey}`;
    if (lastActiveServerSelectionSource && lastActiveServerSelectionSourceKey === key) {
        return lastActiveServerSelectionSource;
    }

    if (!activeServerId && availableServerIds.length === 0) {
        lastActiveServerSelectionSource = emptyActiveServerSelectionSource;
        lastActiveServerSelectionSourceKey = key;
        return emptyActiveServerSelectionSource;
    }

    const source: ActiveServerSelectionSource = {
        activeServerId,
        availableServerIds,
        serverProfiles,
    };
    lastActiveServerSelectionSource = source;
    lastActiveServerSelectionSourceKey = key;
    return source;
}

function useActiveServerSelectionSource(): ActiveServerSelectionSource {
    useServerProfilesGeneration();
    return React.useSyncExternalStore(
        subscribeActiveServer,
        getActiveServerSelectionSourceSnapshot,
        getActiveServerSelectionSourceSnapshot,
    );
}

export function useResolvedActiveServerSelection(): ResolvedActiveServerSelection {
    const groups = useSetting('serverSelectionGroups');
    const activeKind = useSetting('serverSelectionActiveTargetKind');
    const activeId = useSetting('serverSelectionActiveTargetId');
    const activeServer = useActiveServerSelectionSource();

    return React.useMemo(
        () => {
            const settings = normalizeServerSelectionSettingsForProfileScopeIds({
                serverSelectionGroups: groups,
                serverSelectionActiveTargetKind: activeKind,
                serverSelectionActiveTargetId: activeId,
            }, activeServer.serverProfiles);
            return resolveActiveServerSelectionFromRawSettings({
                activeServerId: activeServer.activeServerId,
                availableServerIds: activeServer.availableServerIds,
                settings,
            });
        },
        [activeId, activeKind, activeServer, groups],
    );
}

export function useEffectiveServerSelection(): EffectiveServerSelection {
    const groups = useSetting('serverSelectionGroups');
    const activeKind = useSetting('serverSelectionActiveTargetKind');
    const activeId = useSetting('serverSelectionActiveTargetId');
    const activeServer = useActiveServerSelectionSource();

    return React.useMemo(
        () => {
            const settings = normalizeServerSelectionSettingsForProfileScopeIds({
                serverSelectionGroups: groups,
                serverSelectionActiveTargetKind: activeKind,
                serverSelectionActiveTargetId: activeId,
            }, activeServer.serverProfiles);
            return getEffectiveServerSelectionFromRawSettings({
                activeServerId: activeServer.activeServerId,
                availableServerIds: activeServer.availableServerIds,
                settings,
            });
        },
        [activeId, activeKind, activeServer, groups],
    );
}
