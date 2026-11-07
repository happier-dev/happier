import * as React from 'react';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol';
import { useAuth } from '@/auth/context/AuthContext';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { buildQuotaSnapshotScopeKey, getQuotaSnapshotEntry, subscribeQuotaSnapshotEntry } from '@/sync/domains/connectedServices/connectedServiceQuotaSnapshotStore';
import { isProviderAccountUsageRefreshing, subscribeProviderAccountUsageRefresh } from '@/sync/domains/connectedServices/accountUsage/refreshProviderAccountUsage';

/** Observe the displayed account's existing refresh owner; this never fetches or starts a timer. */
export function useProviderUsageRefreshState(serviceId: string, sourceProfileId: string): boolean {
    const credentials = useAuth().credentials;
    const scope = credentials ? resolveAuthCredentialsScopeKey(credentials) : '';
    // Native display snapshots use the canonical acct:<recordId> alias from accountUsage/projection.
    const recordId = sourceProfileId.startsWith('acct:') ? sourceProfileId.slice(5) : null;
    const service = ConnectedServiceIdSchema.safeParse(serviceId);
    const quotaKey = scope && !recordId && service.success
        ? buildQuotaSnapshotScopeKey(scope, service.data, sourceProfileId) : null;
    const subscribe = React.useCallback((listener: () => void) => (
        scope && recordId
            ? subscribeProviderAccountUsageRefresh(scope, recordId, listener)
            : subscribeQuotaSnapshotEntry(quotaKey, listener)
    ), [scope, recordId, quotaKey]);
    const getSnapshot = React.useCallback(() => (
        scope && recordId ? isProviderAccountUsageRefreshing(scope, recordId) : getQuotaSnapshotEntry(quotaKey).refreshing
    ), [scope, recordId, quotaKey]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
