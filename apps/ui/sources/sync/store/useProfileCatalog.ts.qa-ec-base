import * as React from 'react';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { invalidateProfileCatalogProjection, observeProfileCatalog } from '@/sync/engine/settings/profileCatalogEngine';
import { getProfileCatalogSnapshot, subscribeProfileCatalogSnapshots } from '@/sync/store/settings/profileCatalogSnapshot';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';

/** Exact scoped selector: sibling catalog publications retain this snapshot identity. */
export function useProfileCatalog(scope: ServerAccountScope | null | undefined) {
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const captured = React.useMemo(() => serverId && accountId ? { serverId, accountId } : null, [serverId, accountId]);
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const lifetime = areAccountSettingsScopesEqual(activeLifetime?.scope, captured) ? activeLifetime : null;
    const observation = React.useRef<{ scope: ServerAccountScope; lifetime: typeof lifetime } | null>(null);
    React.useEffect(() => {
        if (!captured) {
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
    }, [captured, lifetime]);
    const read = React.useCallback(() => getProfileCatalogSnapshot(captured), [captured]);
    return React.useSyncExternalStore(subscribeProfileCatalogSnapshots, read, read);
}
