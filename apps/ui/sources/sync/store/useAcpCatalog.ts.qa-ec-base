import * as React from 'react';
import type { AcpCatalogRecordV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { invalidateAcpCatalogProjection, observeAcpCatalog } from '@/sync/engine/settings/acpCatalogEngine';
import { getAcpCatalogSnapshot, subscribeAcpCatalogSnapshots } from '@/sync/store/settings/acpCatalogSnapshot';
import { AcpCatalogOperationError, requireUpdatedAcpCatalogMutation, writeAcpCatalogRecord } from '@/sync/api/account/apiAcpCatalog';
import { getStorage } from '@/sync/domains/state/storage';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

type AcpCatalogDemand = Readonly<{ enabled?: boolean }>;

/** A Home alone cannot manufacture an Account. Unknown or different Homes remain unavailable. */
export function useAcpCatalogForServer(requestedServerId?: string | null, requestedScope?: ServerAccountScope | null, demand?: AcpCatalogDemand) {
    const activeScope = useAccountSettingsScope();
    const accountScope = requestedScope === undefined ? activeScope : requestedScope;
    const scope = requestedServerId === undefined ? accountScope
        : requestedServerId && accountScope && areServerProfileIdentifiersEquivalent(requestedServerId, accountScope.serverId)
            ? accountScope : null;
    return useAcpCatalog(scope, demand);
}

/** The ready catalog and its CAS stay scoped independently of Account preferences. */
export function useAcpCatalog(requestedScope?: ServerAccountScope | null, demand?: AcpCatalogDemand) {
    const presented = useLayoutPresentationActive();
    const enabled = demand?.enabled !== false && presented;
    const activeScope = useAccountSettingsScope();
    const scope = requestedScope === undefined ? activeScope : requestedScope;
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const captured = React.useMemo(() => serverId && accountId ? { serverId, accountId } : null, [serverId, accountId]);
    React.useEffect(() => enabled && captured ? observeAcpCatalog(captured) : undefined, [captured, enabled]);
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const lifetime = areAccountSettingsScopesEqual(activeLifetime?.scope, captured) ? activeLifetime : null;
    const observation = React.useRef<{ scope: ServerAccountScope; lifetime: typeof lifetime } | null>(null);
    React.useEffect(() => {
        if (!enabled) return;
        if (!captured) {
            observation.current = null;
            return;
        }
        const previous = observation.current;
        observation.current = { scope: captured, lifetime };
        // A retired read cannot publish, even when another observer retains the loader.
        if (lifetime && previous && previous.lifetime !== lifetime
            && areAccountSettingsScopesEqual(previous.scope, captured)
            && getAcpCatalogSnapshot(captured)?.stale !== false) {
            void invalidateAcpCatalogProjection(captured).catch(() => {});
        }
    }, [captured, enabled, lifetime]);
    const read = React.useCallback(() => getAcpCatalogSnapshot(captured), [captured]);
    const subscribe = React.useCallback((listener: () => void) => enabled
        ? subscribeAcpCatalogSnapshots(listener) : () => {}, [enabled]);
    const snapshot = React.useSyncExternalStore(subscribe, read, read);
    const write = React.useCallback(async (record: AcpCatalogRecordV1) => {
        if (!enabled || !captured || snapshot?.catalog.status !== 'ready' || snapshot.stale) throw new AcpCatalogOperationError('catalog-unavailable');
        const catalog = snapshot.catalog;
        const result = await writeAcpCatalogRecord(captured, { record, expectedRevision: catalog.revision,
            ...(catalog.revision === 'absent' ? { sourceSettingsVersion: catalog.sourceSettingsVersion } : {}) });
        requireUpdatedAcpCatalogMutation(result);
        if (!areAccountSettingsScopesEqual(captured, getStorage().getState().settingsScope)) throw new AcpCatalogOperationError('scope-retired');
        return result;
    }, [captured, enabled, snapshot]);
    return React.useMemo(() => ({ snapshot, write }), [snapshot, write]);
}
