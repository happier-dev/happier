import * as React from 'react';
import type { HomeAccountRowV1 } from '@happier-dev/protocol/home/governance';

import type { HomeActionFailure as HomeDomainFailure } from '@/sync/ops/home/homeActionOutcome';
import { createServerAccountScope, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { loadMoreHomeAccountRoster, observeHomeAccountRoster, refreshHomeAccountRoster } from '@/sync/engine/home/governance/homeAccountRosterEngine';
import { getHomeAccountRosterSnapshot, subscribeHomeAccountRosterSnapshot, type HomeAccountRosterStatus } from '@/sync/store/home/governance/homeAccountRosterSnapshots';

export type { HomeAccountRosterStatus } from '@/sync/store/home/governance/homeAccountRosterSnapshots';

export type HomeAccountRoster = Readonly<{
    rows: readonly HomeAccountRowV1[];
    /** Exact Home total when supplied or once every roster page is read; otherwise null. */
    total: number | null;
    status: HomeAccountRosterStatus;
    /** Retained across a failed page load so the list never blanks. */
    error: HomeDomainFailure | null;
    hasMore: boolean;
    loadMore: () => void;
    reload: () => void;
}>;

const NO_ROWS: readonly HomeAccountRowV1[] = Object.freeze([]);

/** Consumers observe one admitted paged resource; the engine owns reads and freshness. */
export function useHomeAccountRoster(scope: ServerAccountScope | null, enabled: boolean): HomeAccountRoster {
    const serverId = enabled ? scope?.serverId ?? '' : '';
    const accountId = enabled ? scope?.accountId ?? '' : '';
    const getSnapshot = React.useCallback(() => getHomeAccountRosterSnapshot(createServerAccountScope(serverId, accountId)), [serverId, accountId]);
    const subscribe = React.useCallback((listener: () => void) => subscribeHomeAccountRosterSnapshot(createServerAccountScope(serverId, accountId), listener), [serverId, accountId]);
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    React.useEffect(() => {
        const observedScope = createServerAccountScope(serverId, accountId);
        if (observedScope) return observeHomeAccountRoster(observedScope);
    }, [serverId, accountId]);

    const loadMore = React.useCallback(() => {
        const current = createServerAccountScope(serverId, accountId);
        if (current) void loadMoreHomeAccountRoster(current);
    }, [serverId, accountId]);
    const reload = React.useCallback(() => {
        const current = createServerAccountScope(serverId, accountId);
        if (current) void refreshHomeAccountRoster(current);
    }, [serverId, accountId]);

    return React.useMemo(() => Object.freeze({
        rows: snapshot?.rows ?? NO_ROWS,
        total: snapshot?.total ?? null,
        status: snapshot?.status ?? 'loading',
        error: snapshot?.error ?? null,
        hasMore: snapshot?.hasMore ?? true,
        loadMore,
        reload,
    }), [snapshot, loadMore, reload]);
}
