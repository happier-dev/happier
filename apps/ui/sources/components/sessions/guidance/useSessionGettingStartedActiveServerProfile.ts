import * as React from 'react';

import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';

import { resolveActiveServerProfile } from './gettingStartedModel';

export function useSessionGettingStartedActiveServerProfile(activeServerId: string) {
    const serverProfilesGeneration = useServerProfilesGeneration();
    const serverProfiles = React.useMemo(() => {
        return listServerProfiles().map((p) => ({
            id: p.id,
            name: p.name,
            serverUrl: p.serverUrl,
            serverIdentityId: p.serverIdentityId ?? null,
            legacyServerIds: p.legacyServerIds ?? [],
        }));
    }, [serverProfilesGeneration]);

    return React.useMemo(() => {
        return resolveActiveServerProfile(serverProfiles, activeServerId);
    }, [activeServerId, serverProfiles]);
}
