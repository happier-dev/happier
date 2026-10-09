import * as React from 'react';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { observeProviderCatalog } from '@/sync/engine/settings/providerCatalogEngine';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getProviderCatalogSnapshot, subscribeProviderCatalogSnapshots } from '@/sync/store/settings/providerCatalogSnapshot';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export function useProviderCatalog(requestedScope?: ServerAccountScope | null) {
    const active = useAccountSettingsScope();
    const scope = requestedScope === undefined ? active : requestedScope;
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const captured = React.useMemo(() => serverId && accountId ? { serverId, accountId } : null, [serverId, accountId]);
    React.useEffect(() => captured ? observeProviderCatalog(captured) : undefined, [captured]);
    const read = React.useCallback(() => getProviderCatalogSnapshot(captured), [captured]);
    return React.useSyncExternalStore(subscribeProviderCatalogSnapshots, read, read);
}
export function useProviderCatalogForServer(serverId?: string | null) {
    const active = useAccountSettingsScope();
    return useProviderCatalog(serverId === undefined ? active : serverId && active
        && areServerProfileIdentifiersEquivalent(serverId, active.serverId) ? active : null);
}
