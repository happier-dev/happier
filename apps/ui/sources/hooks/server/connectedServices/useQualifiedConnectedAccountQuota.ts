import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

import { useAuth } from '@/auth/context/AuthContext';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import type { ProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';
import {
    type QualifiedConnectedAccountQuotaSnapshotV4} from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import {
    type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import {
    buildQualifiedQuotaCredentialScope,
    buildQualifiedQuotaSnapshotScopeKey,
    getQualifiedQuotaSnapshotEntry,
    loadQualifiedQuotaSnapshotOnce,
    refreshQualifiedQuotaSnapshot,
    retainQualifiedQuotaSnapshotPolling,
    subscribeQualifiedQuotaSnapshotEntry,
    type QualifiedQuotaSnapshotStoreContext,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore';
import type { ConnectedServiceQuotaSnapshotsFetchPolicy } from './useConnectedServiceQuotaSnapshots';

export type UseQualifiedConnectedAccountQuotaResult = Readonly<{
    supported: boolean | null;
    snapshot: QualifiedConnectedAccountQuotaSnapshotV4 | null;
    /** The provider usage record the server read this quota from (its subscription lives there). */
    usageRecordId: ProviderAccountUsageRecordId | null;
    loading: boolean;
    refreshing: boolean;
    error: string | null;
    refresh(): Promise<void>;
}>;

export function useQualifiedConnectedAccountQuota(
    ref: QualifiedConnectedAccountRef,
    options: Readonly<{ refreshMachineId?: string | null; fetchPolicy?: ConnectedServiceQuotaSnapshotsFetchPolicy }> = {},
): UseQualifiedConnectedAccountQuotaResult {
    const presented = useLayoutPresentationActive();
    const credentials = useAuth().credentials;
    const activeServer = useActiveServerSnapshot();
    const refreshMachineId = options.refreshMachineId;
    const fetchPolicy = options.fetchPolicy ?? 'poll';
    const servicePluginId = ref.service.pluginId;
    const serviceLocalId = ref.service.localId;
    const accountId = ref.accountId;

    const exactRef = React.useMemo<QualifiedConnectedAccountRef>(() => ({
        service: {
            pluginId: servicePluginId,
            localId: serviceLocalId,
        },
        accountId,
    }), [accountId, serviceLocalId, servicePluginId]);
    const credentialScope =
        credentials && activeServer.serverId
            ? buildQualifiedQuotaCredentialScope(credentials, activeServer)
            : '';
    const context =
        React.useMemo<QualifiedQuotaSnapshotStoreContext | null>(() => {
            if (!credentials || !activeServer.serverId) return null;
            return {
                credentials,
                credentialScope,
                ref: exactRef,
                serverBasis: {
                    serverId: activeServer.serverId,
                    generation: activeServer.generation,
                },
                refreshMachineId,
            };
        }, [
            activeServer.generation,
            activeServer.serverId,
            refreshMachineId,
            credentialScope,
            credentials,
            exactRef,
        ]);
    const key = React.useMemo(
        () => context
            ? buildQualifiedQuotaSnapshotScopeKey(context)
            : null,
        [context],
    );
    const subscribe = React.useCallback(
        (onChange: () => void) =>
            presented ? subscribeQualifiedQuotaSnapshotEntry(key, onChange) : () => {},
        [key, presented],
    );
    const getEntry = React.useCallback(
        () => getQualifiedQuotaSnapshotEntry(key),
        [key],
    );
    const entry = React.useSyncExternalStore(
        subscribe,
        getEntry,
        getEntry,
    );

    React.useEffect(() => {
        if (!presented || !key || !context || fetchPolicy === 'cache_only') return;
        return fetchPolicy === 'once'
            ? loadQualifiedQuotaSnapshotOnce(key, context)
            : retainQualifiedQuotaSnapshotPolling(key, context);
    }, [context, fetchPolicy, key, presented]);

    const refresh = React.useCallback(async () => {
        if (!key || !context || entry.supported === false) return;
        await refreshQualifiedQuotaSnapshot(key, context);
    }, [
        context,
        entry.supported,
        key,
    ]);

    return {
        supported: key ? entry.supported : null,
        snapshot: key ? entry.snapshot : null,
        usageRecordId: key ? entry.usageRecordId : null,
        loading: key
            ? entry.loading
                || (
                    fetchPolicy !== 'cache_only' && !entry.read
                    && entry.error === null
                )
            : false,
        refreshing: entry.refreshing,
        error: key ? entry.error : null,
        refresh,
    };
}
