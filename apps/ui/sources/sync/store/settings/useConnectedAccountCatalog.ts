import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { ConnectedAccountCatalogKeyV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { observeConnectedAccountCatalog } from '@/sync/engine/settings/connectedAccountCatalogEngine';
import { getConnectedAccountCatalogValue, subscribeConnectedAccountCatalogSnapshots,
    type ConnectedAccountCatalogValueSnapshot } from './connectedAccountCatalogSnapshot';

const noSubscription = () => () => {};

type CatalogOptions = Readonly<{ sourceMachineId?: string | null; enabled?: boolean }>;

export function useConnectedAccountCatalog<K extends ConnectedAccountCatalogKeyV1>(key: K, requestedScope?: ServerAccountScope | null,
    options?: CatalogOptions): ConnectedAccountCatalogValueSnapshot<K>;
export function useConnectedAccountCatalog<K extends ConnectedAccountCatalogKeyV1, T>(key: K, requestedScope: ServerAccountScope | null | undefined,
    options: CatalogOptions | undefined, selector: (snapshot: ConnectedAccountCatalogValueSnapshot<K>) => T): T;
export function useConnectedAccountCatalog<K extends ConnectedAccountCatalogKeyV1, T>(key: K, requestedScope?: ServerAccountScope | null,
    options?: CatalogOptions, selector?: (snapshot: ConnectedAccountCatalogValueSnapshot<K>) => T) {
    const activeScope = useActiveServerAccountScope();
    const scope = requestedScope === undefined ? activeScope : requestedScope;
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const sourceMachineId = key === 'purposes' ? options?.sourceMachineId?.trim() || undefined : undefined;
    const enabled = options?.enabled !== false;
    useEffect(() => enabled && serverId && accountId ? observeConnectedAccountCatalog({ serverId, accountId }, key, { sourceMachineId }) : undefined,
        [serverId, accountId, key, sourceMachineId, enabled]);
    const read = useCallback(() => {
        const snapshot = getConnectedAccountCatalogValue(serverId && accountId ? { serverId, accountId } : null, key);
        return selector ? selector(snapshot) : snapshot;
    }, [serverId, accountId, key, selector]);
    return useSyncExternalStore(enabled ? subscribeConnectedAccountCatalogSnapshots : noSubscription, read, read);
}
