import * as React from 'react';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { observeConnectedMetadataCatalog } from '@/sync/engine/settings/connectedMetadataCatalogEngine';
import { getConnectedMetadataCatalog, subscribeConnectedMetadataCatalog,
    type ConnectedMetadataCatalogSnapshot } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';

export const selectConnectedMetadataLabels = (snapshot: ConnectedMetadataCatalogSnapshot) => snapshot.labelsByKey;
export const selectConnectedMetadataAcknowledgements = (snapshot: ConnectedMetadataCatalogSnapshot) => snapshot.acknowledgementsByKey;
export function useConnectedMetadataCatalog(scope?: ServerAccountScope | null): ConnectedMetadataCatalogSnapshot;
export function useConnectedMetadataCatalog<T>(scope: ServerAccountScope | null | undefined, selector: (snapshot: ConnectedMetadataCatalogSnapshot) => T): T;
export function useConnectedMetadataCatalog<T>(requestedScope?: ServerAccountScope | null, selector?: (snapshot: ConnectedMetadataCatalogSnapshot) => T) {
    const activeServer = useActiveServerSnapshot();
    const activeScope = useActiveServerAccountScope(requestedScope?.serverId ?? activeServer.serverId);
    const selectedScope = requestedScope === undefined ? activeScope : requestedScope;
    const scope = React.useMemo<ServerAccountScope | null>(() => selectedScope
        ? { serverId: selectedScope.serverId, accountId: selectedScope.accountId } : null,
    [selectedScope?.serverId, selectedScope?.accountId]);
    const read = React.useCallback(() => {
        const snapshot = getConnectedMetadataCatalog(scope);
        return selector ? selector(snapshot) : snapshot;
    }, [scope, selector]);
    const snapshot = React.useSyncExternalStore(subscribeConnectedMetadataCatalog, read, read);
    React.useEffect(() => scope ? observeConnectedMetadataCatalog(scope) : undefined, [scope]);
    return snapshot;
}
