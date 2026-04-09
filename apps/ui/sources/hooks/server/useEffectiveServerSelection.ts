import * as React from 'react';

import { useSetting } from '@/sync/domains/state/storage';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import {
    getEffectiveServerSelectionFromRawSettings,
    resolveActiveServerSelectionFromRawSettings,
} from '@/sync/domains/server/selection/serverSelectionResolution';
import type {
    EffectiveServerSelection,
    ResolvedActiveServerSelection,
} from '@/sync/domains/server/selection/serverSelectionTypes';
import { useActiveServerSnapshot } from './useActiveServerSnapshot';
import { useServerProfilesGeneration } from './useServerProfilesGeneration';

export function useResolvedActiveServerSelection(): ResolvedActiveServerSelection {
    const groups = useSetting('serverSelectionGroups');
    const activeKind = useSetting('serverSelectionActiveTargetKind');
    const activeId = useSetting('serverSelectionActiveTargetId');
    const activeServer = useActiveServerSnapshot();
    const serverProfilesGeneration = useServerProfilesGeneration();

    const availableServerIds = React.useMemo(
        () => listServerProfiles().map((profile) => profile.id),
        // Server-profile writes can land without changing the active-server snapshot.
        // Subscribe to the profile generation as well so derived selection refreshes when
        // the available server set hydrates after an initially empty pass.
        [activeServer.generation, serverProfilesGeneration],
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
    const activeServer = useActiveServerSnapshot();
    const serverProfilesGeneration = useServerProfilesGeneration();

    const availableServerIds = React.useMemo(
        () => listServerProfiles().map((profile) => profile.id),
        [activeServer.generation, serverProfilesGeneration],
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
