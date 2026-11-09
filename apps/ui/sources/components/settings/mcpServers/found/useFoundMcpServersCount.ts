import * as React from 'react';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createFoundMcpServersCountReader } from '@/sync/domains/state/warmCachePersistence';

/** Reads only existing Found results; the detected page and Action ingress remain the scan owners. */
export function useFoundMcpServersCount(machineIds: readonly string[], scope: ServerAccountScope | null, enabled = true): number | null {
    const idsKey = JSON.stringify([...new Set(machineIds)].sort());
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const reader = React.useMemo(() => createFoundMcpServersCountReader(serverId ?? '', accountId ?? '',
        enabled && serverId && accountId ? JSON.parse(idsKey) as string[] : []), [accountId, enabled, idsKey, serverId]);
    return React.useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
}
