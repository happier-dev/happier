import * as React from 'react';

import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { readServerRetentionPolicy, type ServerRetentionPolicy } from '@/sync/domains/server/retention/serverRetentionPolicy';

export function useServerRetentionPolicy(serverId?: string | null): ServerRetentionPolicy | null {
    const snapshot = useServerFeaturesSnapshotForServerId(serverId ?? null, { enabled: Boolean(serverId) });

    return React.useMemo(() => {
        if (snapshot.status !== 'ready') return null;
        return readServerRetentionPolicy(snapshot.features);
    }, [snapshot]);
}
