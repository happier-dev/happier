import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import {
    resolveAuthCredentialsScopeKey,
} from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import {
    type QualifiedConnectedAccountQuotaSnapshotV4,
    type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import {
    useConnectedAccountOperationAdmission,
} from './useConnectedServiceLegacyOperationAdmission';
import {
    buildQualifiedQuotaSnapshotScopeKey,
    getQualifiedQuotaSnapshotEntry,
    refreshQualifiedQuotaSnapshot,
    retainQualifiedQuotaSnapshotPolling,
    subscribeQualifiedQuotaSnapshotEntry,
    type QualifiedQuotaSnapshotStoreContext,
} from './qualifiedConnectedAccountQuotaSnapshotStore';

export type UseQualifiedConnectedAccountQuotaResult = Readonly<{
    supported: boolean | null;
    snapshot: QualifiedConnectedAccountQuotaSnapshotV4 | null;
    loading: boolean;
    refreshing: boolean;
    error: string | null;
    refresh(): Promise<void>;
}>;

export function useQualifiedConnectedAccountQuota(
    ref: QualifiedConnectedAccountRef,
): UseQualifiedConnectedAccountQuotaResult {
    const credentials = useAuth().credentials;
    const activeServer = useActiveServerSnapshot();
    const assertAccountOperationAllowed =
        useConnectedAccountOperationAdmission();
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
    const assertOperationAllowed = React.useCallback(
        (operation: Parameters<
            typeof assertAccountOperationAllowed
        >[2]) => assertAccountOperationAllowed(
            exactRef.service,
            { kind: 'v4' },
            operation,
        ),
        [assertAccountOperationAllowed, exactRef.service],
    );
    const credentialScope =
        credentials && activeServer.serverId
            ? [
                activeServer.serverId,
                resolveAuthCredentialsScopeKey(credentials),
            ].join('\u0000')
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
                assertOperationAllowed,
            };
        }, [
            activeServer.generation,
            activeServer.serverId,
            assertOperationAllowed,
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
            subscribeQualifiedQuotaSnapshotEntry(key, onChange),
        [key],
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
        if (!key || !context) return;
        return retainQualifiedQuotaSnapshotPolling(key, context);
    }, [context, key]);

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
        loading: key
            ? entry.loading
                || (
                    entry.supported === null
                    && entry.error === null
                )
            : false,
        refreshing: entry.refreshing,
        error: key ? entry.error : null,
        refresh,
    };
}
