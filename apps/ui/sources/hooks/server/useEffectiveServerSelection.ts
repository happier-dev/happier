import * as React from 'react';

import { useSetting } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import {
    getEffectiveServerSelectionFromRawSettings,
    resolveActiveServerSelectionFromRawSettings,
} from '@/sync/domains/server/selection/serverSelectionResolution';
import type {
    EffectiveServerSelection,
    ResolvedActiveServerSelection,
} from '@/sync/domains/server/selection/serverSelectionTypes';

function useActiveServerSnapshotForSelection(): { serverId: string; generation: number } {
    const [snapshot, setSnapshot] = React.useState(() => getActiveServerSnapshot());

    React.useEffect(() => {
        return subscribeActiveServer(setSnapshot);
    }, []);

    return snapshot;
}

export function useResolvedActiveServerSelection(): ResolvedActiveServerSelection {
    const groups = useSetting('serverSelectionGroups');
    const activeKind = useSetting('serverSelectionActiveTargetKind');
    const activeId = useSetting('serverSelectionActiveTargetId');
    const activeServer = useActiveServerSnapshotForSelection();

    const availableServerIds = React.useMemo(
        () => listServerProfiles().map((profile) => profile.id),
        // server profile mutations bump the active server generation, so this is "good enough" reactivity.
        [activeServer.generation],
    );

    return React.useMemo(
        () =>
            resolveActiveServerSelectionFromRawSettings({
                activeServerId: activeServer.serverId,
                availableServerIds,
                settings: {
                    serverSelectionGroups: groups,
                    serverSelectionActiveTargetKind: activeKind,
                    serverSelectionActiveTargetId: activeId,
                },
            }),
        [activeId, activeKind, activeServer.serverId, availableServerIds, groups],
    );
}

export function useEffectiveServerSelection(): EffectiveServerSelection {
    const groups = useSetting('serverSelectionGroups');
    const activeKind = useSetting('serverSelectionActiveTargetKind');
    const activeId = useSetting('serverSelectionActiveTargetId');
    const activeServer = useActiveServerSnapshotForSelection();

    const availableServerIds = React.useMemo(
        () => listServerProfiles().map((profile) => profile.id),
        [activeServer.generation],
    );

    return React.useMemo(
        () =>
            getEffectiveServerSelectionFromRawSettings({
                activeServerId: activeServer.serverId,
                availableServerIds,
                settings: {
                    serverSelectionGroups: groups,
                    serverSelectionActiveTargetKind: activeKind,
                    serverSelectionActiveTargetId: activeId,
                },
            }),
        [activeId, activeKind, activeServer.serverId, availableServerIds, groups],
    );
}

