import * as React from 'react';
import type { AcpCatalogRecordV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { observeAcpCatalog } from '@/sync/engine/settings/acpCatalogEngine';
import { getAcpCatalogSnapshot, subscribeAcpCatalogSnapshots } from '@/sync/store/settings/acpCatalogSnapshot';
import { AcpCatalogOperationError, requireUpdatedAcpCatalogMutation, writeAcpCatalogRecord } from '@/sync/api/account/apiAcpCatalog';
import { getStorage } from '@/sync/domains/state/storage';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

/** A Home alone cannot manufacture an Account. Unknown or different Homes remain unavailable. */
export function useAcpCatalogForServer(requestedServerId?: string | null, requestedScope?: ServerAccountScope | null) {
    const activeScope = useAccountSettingsScope();
    const accountScope = requestedScope === undefined ? activeScope : requestedScope;
    const scope = requestedServerId === undefined ? accountScope
        : requestedServerId && accountScope && areServerProfileIdentifiersEquivalent(requestedServerId, accountScope.serverId)
            ? accountScope : null;
    return useAcpCatalog(scope);
}

/** The ready catalog and its CAS stay scoped independently of Account preferences. */
export function useAcpCatalog(requestedScope?: ServerAccountScope | null) {
    const activeScope = useAccountSettingsScope();
    const scope = requestedScope === undefined ? activeScope : requestedScope;
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const captured = React.useMemo(() => serverId && accountId ? { serverId, accountId } : null, [serverId, accountId]);
    React.useEffect(() => captured ? observeAcpCatalog(captured) : undefined, [captured]);
    const read = React.useCallback(() => getAcpCatalogSnapshot(captured), [captured]);
    const snapshot = React.useSyncExternalStore(subscribeAcpCatalogSnapshots, read, read);
    const write = React.useCallback(async (record: AcpCatalogRecordV1) => {
        if (!captured || snapshot?.catalog.status !== 'ready' || snapshot.stale) throw new AcpCatalogOperationError('catalog-unavailable');
        const catalog = snapshot.catalog;
        const result = await writeAcpCatalogRecord(captured, { record, expectedRevision: catalog.revision,
            ...(catalog.revision === 'absent' ? { sourceSettingsVersion: catalog.sourceSettingsVersion } : {}) });
        requireUpdatedAcpCatalogMutation(result);
        if (!areAccountSettingsScopesEqual(captured, getStorage().getState().settingsScope)) throw new AcpCatalogOperationError('scope-retired');
        return result;
    }, [captured, snapshot]);
    return React.useMemo(() => ({ snapshot, write }), [snapshot, write]);
}
