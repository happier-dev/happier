import * as React from 'react';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { observeProviderCatalog } from '@/sync/engine/settings/providerCatalogEngine';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getProviderCatalogSnapshot, subscribeProviderCatalogSnapshots } from '@/sync/store/settings/providerCatalogSnapshot';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

const noSubscription = () => () => {};

export function useProviderCatalog(requestedScope?: ServerAccountScope | null,
    options?: Readonly<{ enabled?: boolean }>) {
    const active = useAccountSettingsScope();
    const scope = requestedScope === undefined ? active : requestedScope;
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const captured = React.useMemo(() => serverId && accountId ? { serverId, accountId } : null, [serverId, accountId]);
    const enabled = options?.enabled !== false;
    React.useEffect(() => captured && enabled ? observeProviderCatalog(captured) : undefined, [captured, enabled]);
    const read = React.useCallback(() => getProviderCatalogSnapshot(captured), [captured]);
    // Parking presentation withdraws demand, not the scope or its held facts. Reopening
    // reads the current canonical snapshot and rejoins the same observation owner.
    return React.useSyncExternalStore(enabled ? subscribeProviderCatalogSnapshots : noSubscription, read, read);
}
export function useProviderCatalogForServer(serverId?: string | null) {
    const active = useAccountSettingsScope();
    return useProviderCatalog(serverId === undefined ? active : serverId && active
        && areServerProfileIdentifiersEquivalent(serverId, active.serverId) ? active : null);
}
