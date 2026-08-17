import * as React from 'react';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { loadMachineDisplayWarmCacheEntries } from '@/sync/domains/state/warmCachePersistence';
import {
    useIsDataReady,
    useMachineListStatusByServerId,
    useMachineRecordListsByServerId,
    useMachineRecordValues,
    useProfile,
} from '@/sync/store/hooks';

import {
    resolveAllProfileMachineInventorySnapshots,
    type ServerMachineInventorySnapshotV1,
} from './machineInventorySnapshots';

/**
 * The one React projection over the all-profile raw inventory and its
 * presentation-only warm fallback. Administration consumers share this hook
 * instead of independently interpreting active/concurrent machine stores.
 */
export function useAllProfileMachineInventorySnapshots(): readonly ServerMachineInventorySnapshotV1[] {
    const activeServer = useActiveServerSnapshot();
    const serverProfilesGeneration = useServerProfilesGeneration();
    const profiles = React.useMemo(() => listServerProfiles(), [serverProfilesGeneration]);
    const activeMachines = useMachineRecordValues();
    const machineListByServerId = useMachineRecordListsByServerId();
    const machineListStatusByServerId = useMachineListStatusByServerId();
    const activeInventoryLoaded = useIsDataReady();
    const profile = useProfile();

    return React.useMemo(() => resolveAllProfileMachineInventorySnapshots({
        profiles,
        activeServerId: activeServer.serverId,
        activeInventoryLoaded,
        activeMachines,
        machineListByServerId,
        machineListStatusByServerId,
        accountId: profile.id,
        loadWarmEntries: loadMachineDisplayWarmCacheEntries,
    }), [
        activeInventoryLoaded,
        activeMachines,
        activeServer.serverId,
        machineListByServerId,
        machineListStatusByServerId,
        profile.id,
        profiles,
    ]);
}
