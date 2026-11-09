import * as React from 'react';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { invalidateProfileCatalogProjection, observeProfileCatalog } from '@/sync/engine/settings/profileCatalogEngine';
import { getProfileCatalogSnapshot, subscribeProfileCatalogSnapshots } from '@/sync/store/settings/profileCatalogSnapshot';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import type { ProfileCatalogSnapshot } from '@/sync/store/settings/profileCatalogSnapshot';

const noSubscription = () => () => {};
const readSnapshot = (snapshot: ProfileCatalogSnapshot | null) => snapshot;
type CatalogDemand = Readonly<{ enabled?: boolean }>;

/** Exact scoped selector: sibling catalog publications retain this snapshot identity. */
export function useProfileCatalog(scope: ServerAccountScope | null | undefined, demand?: CatalogDemand) {
    return useProfileCatalogSelection(scope, readSnapshot, demand);
}

/** Presentation readers select their facts; effect owners retain the complete snapshot. */
export function useProfileCatalogSelection<T>(scope: ServerAccountScope | null | undefined,
    select: (snapshot: ProfileCatalogSnapshot | null) => T, demand?: CatalogDemand): T {
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const captured = React.useMemo(() => serverId && accountId ? { serverId, accountId } : null, [serverId, accountId]);
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const lifetime = areAccountSettingsScopesEqual(activeLifetime?.scope, captured) ? activeLifetime : null;
    const observation = React.useRef<{ scope: ServerAccountScope; lifetime: typeof lifetime } | null>(null);
    const enabled = demand?.enabled !== false;
    React.useEffect(() => {
        if (!captured || !enabled) {
            observation.current = null;
            return;
        }
        const previous = observation.current;
        observation.current = { scope: captured, lifetime };
        // A retired read cannot publish. Renew the canonical read even when another
        // observer keeps the scoped loader alive across the Account restoration.
        if (lifetime && previous && previous.lifetime !== lifetime
            && areAccountSettingsScopesEqual(previous.scope, captured)) {
            void invalidateProfileCatalogProjection(captured).catch(() => {});
        }
        return observeProfileCatalog(captured);
    }, [captured, enabled, lifetime]);
    const read = React.useCallback(() => select(getProfileCatalogSnapshot(captured)), [captured, select]);
    return React.useSyncExternalStore(enabled ? subscribeProfileCatalogSnapshots : noSubscription, read, read);
}
