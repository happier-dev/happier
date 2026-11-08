import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { sync } from '@/sync/sync';
import { storage } from '@/sync/domains/state/storageStore';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { fireAndForget } from '@/utils/system/fireAndForget';

/** Exact Doc labels consume the canonical opened header, never an independently retained title. */
export function useArtifactTitleProjections(scope: ServerAccountScope | null, artifactIds: readonly string[], active = true): readonly (string | null)[] {
    const presented = useLayoutPresentationActive();
    const current = storage(state => areServerAccountScopesEqual(state.profileScope, scope));
    const titles = storage(useShallow(state => artifactIds.map(id => areServerAccountScopesEqual(state.profileScope, scope)
        && state.artifacts[id]?.isDecrypted ? state.artifacts[id]?.title ?? null : null)));
    React.useEffect(() => {
        if (!active || !presented || !scope || !current) return;
        const missingIds = artifactIds.filter(id => !storage.getState().artifacts[id]?.isDecrypted);
        if (missingIds.length === 0) return;
        const controller = new AbortController();
        fireAndForget(sync.refreshArtifactsByIds(missingIds, { signal: controller.signal }), { tag: 'artifacts.hydrateTitles' });
        return () => controller.abort();
    }, [active, presented, scope?.serverId, scope?.accountId, current, artifactIds]);
    return titles;
}
