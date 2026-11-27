import * as React from 'react';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { HomeAdministrationRead } from '@/sync/engine/home/governance/homeAdministrationReads';

export function useHomeAdministrationRead<T>(
    resource: HomeAdministrationRead<T> | null,
    scope: ServerAccountScope | null,
    accountId?: string,
) {
    const serverId = scope?.serverId;
    const viewerId = scope?.accountId;
    const target = React.useMemo(() => resource && serverId && viewerId
        ? resource.targetFor({ serverId, accountId: viewerId }, accountId)
        : null, [resource, serverId, viewerId, accountId]);
    const subscribe = React.useCallback((listener: () => void) => (
        resource && target ? resource.subscribe(target, listener) : () => {}
    ), [resource, target]);
    const get = React.useCallback(() => resource && target ? resource.get(target) : null, [resource, target]);
    const snapshot = React.useSyncExternalStore(subscribe, get, get);
    React.useEffect(() => {
        if (resource && target) return resource.observe(target);
    }, [resource, target]);
    const refresh = React.useCallback(() => {
        if (resource && target) void resource.refresh(target).catch(() => {});
    }, [resource, target]);
    const adopt = React.useCallback((data: T) => {
        if (resource && target) resource.adopt(target, data);
    }, [resource, target]);
    return { snapshot, refresh, adopt };
}
