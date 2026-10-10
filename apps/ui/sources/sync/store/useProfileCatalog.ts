import * as React from 'react';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { observeProfileCatalog } from '@/sync/engine/settings/profileCatalogEngine';
import { getProfileCatalogSnapshot, subscribeProfileCatalogSnapshots } from '@/sync/store/settings/profileCatalogSnapshot';

/** Exact scoped selector: sibling catalog publications retain this snapshot identity. */
export function useProfileCatalog(scope: ServerAccountScope | null | undefined) {
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const captured = React.useMemo(() => serverId && accountId ? { serverId, accountId } : null, [serverId, accountId]);
    React.useEffect(() => captured ? observeProfileCatalog(captured) : undefined, [captured]);
    const read = React.useCallback(() => getProfileCatalogSnapshot(captured), [captured]);
    return React.useSyncExternalStore(subscribeProfileCatalogSnapshots, read, read);
}
