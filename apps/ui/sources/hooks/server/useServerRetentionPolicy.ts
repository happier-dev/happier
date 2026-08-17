import * as React from 'react';

import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import {
    getCachedServerRetentionPolicy,
    getServerRetentionPolicy,
} from '@/sync/api/capabilities/serverRetentionPolicyClient';
import {
    readServerRetentionPolicy,
    type ServerRetentionPolicyView,
} from '@/sync/domains/server/retention/serverRetentionPolicy';

export function useServerRetentionPolicy(serverId?: string | null): ServerRetentionPolicyView | null {
    const normalizedServerId = String(serverId ?? '').trim();
    const snapshot = useServerFeaturesSnapshotForServerId(normalizedServerId || null, { enabled: Boolean(normalizedServerId) });
    const legacy = React.useMemo(
        () => snapshot.status === 'ready' ? readServerRetentionPolicy(snapshot.features) : null,
        [snapshot],
    );
    const [policy, setPolicy] = React.useState<ServerRetentionPolicyView | null>(
        () => getCachedServerRetentionPolicy(normalizedServerId || undefined) ?? legacy,
    );

    React.useEffect(() => {
        if (!normalizedServerId) {
            setPolicy(null);
            return;
        }
        let active = true;
        const cached = getCachedServerRetentionPolicy(normalizedServerId);
        setPolicy(cached ?? legacy);
        void getServerRetentionPolicy({ serverId: normalizedServerId }).then((next) => {
            if (active) setPolicy(next ?? legacy);
        });
        return () => {
            active = false;
        };
    }, [legacy, normalizedServerId]);

    return policy;
}
