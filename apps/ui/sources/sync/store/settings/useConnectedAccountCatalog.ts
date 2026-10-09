import { useEffect, useSyncExternalStore } from 'react';
import type { ConnectedAccountCatalogKeyV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { observeConnectedAccountCatalog } from '@/sync/engine/settings/connectedAccountCatalogEngine';
import { getConnectedAccountCatalogValue, subscribeConnectedAccountCatalogSnapshots } from './connectedAccountCatalogSnapshot';

export function useConnectedAccountCatalog<K extends ConnectedAccountCatalogKeyV1>(key: K, requestedScope?: ServerAccountScope | null,
    options?: Readonly<{ sourceMachineId?: string | null }>) {
    const activeScope = useActiveServerAccountScope();
    const scope = requestedScope === undefined ? activeScope : requestedScope;
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const sourceMachineId = key === 'purposes' ? options?.sourceMachineId?.trim() || undefined : undefined;
    useEffect(() => serverId && accountId ? observeConnectedAccountCatalog({ serverId, accountId }, key, { sourceMachineId }) : undefined,
        [serverId, accountId, key, sourceMachineId]);
    return useSyncExternalStore(subscribeConnectedAccountCatalogSnapshots,
        () => getConnectedAccountCatalogValue(scope, key), () => getConnectedAccountCatalogValue(scope, key));
}
