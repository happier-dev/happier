import * as React from 'react';

import { readHomeViewSelectionSettings, subscribeHomeViewSelectionSettings } from '@/hooks/server/useHomeViewSelectionSettings';
import { listServerProfiles, subscribeServerProfiles } from '@/sync/domains/server/serverProfiles';
import { readUsableHomeServerIds, subscribeUsableHomeServerIds } from '@/sync/domains/scope/usableHomeServerIds';
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

type ServerSelectionSnapshot = Readonly<{
    settings: ReturnType<typeof readHomeViewSelectionSettings>;
    activeServer: ActiveServerSelectionSource;
    usableServerIds: readonly string[] | null;
    effective: EffectiveServerSelection;
    resolved: () => ResolvedActiveServerSelection;
}>;

let lastServerSelection: ServerSelectionSnapshot | null = null;

/**
 * The effective and resolved Home selection, derived once per change of its inputs (the Home-view
 * selection, the active server and its profiles, the usable Homes) and shared by every reader. A
 * Session screen mounts hundreds of feature decisions that each read this selection; each one used
 * to subscribe to every input and derive the same selection again.
 */
function readServerSelectionSnapshot(): ServerSelectionSnapshot {
    const settings = readHomeViewSelectionSettings();
    const activeServer = getActiveServerSelectionSourceSnapshot();
    const usableServerIds = readUsableHomeServerIds();
    const last = lastServerSelection;
    if (last && last.settings === settings && last.activeServer === activeServer && last.usableServerIds === usableServerIds) return last;
    const normalized = normalizeServerSelectionSettingsForProfileScopeIds(settings, activeServer.serverProfiles);
    const inputs = {
        activeServerId: activeServer.activeServerId,
        availableServerIds: activeServer.availableServerIds,
        settings: normalized,
        usableServerIds,
    };
    let resolved: ResolvedActiveServerSelection | null = null;
    lastServerSelection = {
        settings,
        activeServer,
        usableServerIds,
        effective: getEffectiveServerSelectionFromRawSettings(inputs),
        resolved: () => resolved ??= resolveActiveServerSelectionFromRawSettings(inputs),
    };
    return lastServerSelection;
}

function subscribeServerSelection(listener: () => void): () => void {
    const stops = [
        subscribeHomeViewSelectionSettings(listener),
        subscribeActiveServer(listener),
        subscribeServerProfiles(listener),
        subscribeUsableHomeServerIds(listener),
    ];
    return () => { for (const stop of stops) stop(); };
}

function useServerSelectionSnapshot(): ServerSelectionSnapshot {
    return React.useSyncExternalStore(subscribeServerSelection, readServerSelectionSnapshot, readServerSelectionSnapshot);
}

export function useResolvedActiveServerSelection(): ResolvedActiveServerSelection {
    return useServerSelectionSnapshot().resolved();
}

export function useEffectiveServerSelection(): EffectiveServerSelection {
    return useServerSelectionSnapshot().effective;
}
