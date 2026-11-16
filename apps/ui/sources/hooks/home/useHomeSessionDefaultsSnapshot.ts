import * as React from 'react';
import { createServerAccountScope, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { observeHomeSessionDefaults } from '@/sync/engine/home/governance/homeSessionDefaultsEngine';
import { getHomeSessionDefaultsSnapshot, subscribeHomeSessionDefaultsSnapshots } from '@/sync/store/home/governance/homeSessionDefaultsSnapshots';

export function useHomeSessionDefaultsSnapshot(scope: ServerAccountScope | null) {
    const serverId = scope?.serverId ?? '';
    const accountId = scope?.accountId ?? '';
    const getSnapshot = React.useCallback(() => getHomeSessionDefaultsSnapshot(createServerAccountScope(serverId, accountId)), [serverId, accountId]);
    const snapshot = React.useSyncExternalStore(subscribeHomeSessionDefaultsSnapshots, getSnapshot, getSnapshot);
    React.useEffect(() => {
        const target = createServerAccountScope(serverId, accountId);
        if (target) return observeHomeSessionDefaults(target);
    }, [serverId, accountId]);
    return snapshot;
}
