import * as React from 'react';
import type { AcpCatalogRecordV1, AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { invalidateAcpCatalogProjection, observeAcpCatalog } from '@/sync/engine/settings/acpCatalogEngine';
import { getAcpCatalogSnapshot, subscribeAcpCatalogSnapshots } from '@/sync/store/settings/acpCatalogSnapshot';
import { AcpCatalogOperationError, requireUpdatedAcpCatalogMutation, writeAcpCatalogRecord } from '@/sync/api/account/apiAcpCatalog';
import { getStorage } from '@/sync/domains/state/storage';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { retryServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

type AcpCatalogDemand = Readonly<{ enabled?: boolean }>;

/** Resolve routed Homes through their credential owner; an omitted Home uses the active Account. */
function useAcpCatalogScopeForServer(requestedServerId?: string | null, requestedScope?: ServerAccountScope | null) {
    const activeScope = useAccountSettingsScope();
    const accountScope = requestedScope === undefined ? activeScope : requestedScope;
    const matchesAccount = !requestedServerId || Boolean(accountScope
        && areServerProfileIdentifiersEquivalent(requestedServerId, accountScope.serverId));
    const needsResolution = !matchesAccount && requestedScope === undefined;
    const resolution = useServerCredentialAccountScopeResolution(needsResolution ? requestedServerId : null);
    const scope = matchesAccount ? accountScope : needsResolution && resolution.kind === 'bound' ? resolution.scope : null;
    const unresolvedCatalog: AcpCatalogSnapshotV1 = needsResolution && resolution.kind === 'resolving'
        ? { status: 'loading' } : { status: 'unavailable', reason: needsResolution ? resolution.kind : 'scope-retired' };
    return { scope, unresolvedCatalog };
}

export function useAcpCatalogForServer(requestedServerId?: string | null, requestedScope?: ServerAccountScope | null, demand?: AcpCatalogDemand) {
    const { scope, unresolvedCatalog } = useAcpCatalogScopeForServer(requestedServerId, requestedScope);
    const result = useAcpCatalog(scope, demand);
    const refresh = React.useCallback(() => {
        if (scope) return invalidateAcpCatalogProjection(scope);
        if (requestedServerId) retryServerCredentialAccountScope(requestedServerId);
        return Promise.resolve();
    }, [scope, requestedServerId]);
    return { ...result, catalog: result.snapshot?.catalog ?? (scope ? { status: 'loading' as const } : unresolvedCatalog), refresh };
}

export function useAcpCatalogDataForServer(requestedServerId?: string | null, requestedScope?: ServerAccountScope | null, demand?: AcpCatalogDemand) {
    const { scope } = useAcpCatalogScopeForServer(requestedServerId, requestedScope);
    return useAcpCatalogData(scope, demand);
}

function useAcpCatalogSource(requestedScope?: ServerAccountScope | null, demand?: AcpCatalogDemand) {
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
    return { captured, enabled, read, subscribe };
}

/** Display-only data retains continuity; it supplies no mutation or execution authority. */
export function useAcpCatalogData(requestedScope?: ServerAccountScope | null, demand?: AcpCatalogDemand) {
    const { read, subscribe } = useAcpCatalogSource(requestedScope, demand);
    const readData = React.useCallback(() => read()?.data ?? null, [read]);
    return React.useSyncExternalStore(subscribe, readData, readData);
}

/** The ready catalog and its CAS stay scoped independently of Account preferences. */
export function useAcpCatalog(requestedScope?: ServerAccountScope | null, demand?: AcpCatalogDemand) {
    const { captured, enabled, read, subscribe } = useAcpCatalogSource(requestedScope, demand);
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
