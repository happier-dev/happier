import * as React from 'react';

import { getCachedServerRetentionPolicy, getServerRetentionPolicy } from '@/sync/api/capabilities/serverRetentionPolicyClient';
import type { ServerRetentionPolicyView } from '@/sync/domains/server/retention/serverRetentionPolicy';
import { fireAndForget } from '@/utils/system/fireAndForget';

export function useServerRetentionPolicy(serverId?: string | null): ServerRetentionPolicyView | null {
    const normalizedServerId = String(serverId ?? '').trim();
    const [policy, setPolicy] = React.useState<ServerRetentionPolicyView | null>(() => (
        normalizedServerId ? getCachedServerRetentionPolicy(normalizedServerId) : null
    ));

    React.useEffect(() => {
        let cancelled = false;
        if (!normalizedServerId) {
            setPolicy(null);
            return () => { cancelled = true; };
        }
        setPolicy(getCachedServerRetentionPolicy(normalizedServerId));
        fireAndForget((async () => {
            const next = await getServerRetentionPolicy({ serverId: normalizedServerId });
            if (!cancelled) setPolicy(next);
        })(), { tag: 'useServerRetentionPolicy.load' });
        return () => { cancelled = true; };
    }, [normalizedServerId]);

    return policy;
}
