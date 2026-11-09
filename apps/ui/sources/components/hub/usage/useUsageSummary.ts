import * as React from 'react';

import {
    useConnectedServiceQuotaSummaries,
} from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';

import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import {
    loadUsageSummaryWarmCache,
    saveUsageSummaryWarmCache,
} from '@/sync/domains/state/warmCachePersistence';

import { buildUsageSummary, buildUsageSummaryCache, type UsageSummary } from './usageSummaryPresentation';
export { buildUsageSummary, buildUsageSummaryCache, type UsageSummary, type UsageSummaryEntry } from './usageSummaryPresentation';

/**
 * The Account's usage windows (each connected account's quota meters), for the hubs and the
 * sidebar Usage popover. It shows what this launch read, else the last value this device saved with
 * its time, and saves each new read. `load: 'visible'` retains the shared quota observation while
 * the surface is open, revalidating retained data on return. `load: 'cache'` never starts a read.
 * Reads keep the quota owner's exact Account/ref admission; explicit provider refresh stays separate.
 */
export function useUsageSummary(options: Readonly<{ load: 'visible' | 'cache' }>): UsageSummary {
    const { summaries, accountsWithoutUsage } = useConnectedServiceQuotaSummaries({
        fetchPolicy: options.load === 'visible' ? 'poll' : 'cache_only',
    });
    const scope = useActiveServerAccountScope();
    const serverId = scope?.serverId ?? null;
    const accountId = scope?.accountId ?? null;

    const live = React.useMemo(() => buildUsageSummaryCache(summaries), [summaries]);

    React.useEffect(() => {
        if (live && serverId && accountId) saveUsageSummaryWarmCache(serverId, accountId, live);
    }, [accountId, live, serverId]);

    const saved = React.useMemo(
        () => (serverId && accountId ? loadUsageSummaryWarmCache(serverId, accountId) : null),
        [accountId, serverId],
    );

    return React.useMemo(
        () => buildUsageSummary({ live, saved, accountsWithoutUsage }),
        [accountsWithoutUsage, live, saved],
    );
}
