import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useLayoutPresentationSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { sync } from '@/sync/sync';
import { storage } from '@/sync/domains/state/storageStore';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { fireAndForget } from '@/utils/system/fireAndForget';

/** Exact Doc labels consume the canonical opened header, never an independently retained title. */
export function useArtifactTitleProjections(scope: ServerAccountScope | null, artifactIds: readonly string[], active = true): readonly (string | null)[] {
    const presentedSignal = useLayoutPresentationSignal();
    const current = storage(state => areServerAccountScopesEqual(state.profileScope, scope));
    const titles = storage(useShallow(state => artifactIds.map(id => areServerAccountScopesEqual(state.profileScope, scope)
        && state.artifacts[id]?.isDecrypted ? state.artifacts[id]?.title ?? null : null)));
    React.useEffect(() => {
        // Presentation only starts and stops this work: a subscription, so a show/hide renders nothing here.
        const start = (presented: boolean): (() => void) | void => {
            if (!active || !presented || !scope || !current) return;
            const missingIds = artifactIds.filter(id => !storage.getState().artifacts[id]?.isDecrypted);
            if (missingIds.length === 0) return;
            const controller = new AbortController();
            fireAndForget(sync.refreshArtifactsByIds(missingIds, { signal: controller.signal }), { tag: 'artifacts.hydrateTitles' });
            return () => controller.abort();
        };
        let presented = presentedSignal.get();
        let stop = start(presented);
        const unsubscribe = presentedSignal.subscribe(() => {
            if (presentedSignal.get() === presented) return;
            presented = presentedSignal.get();
            stop?.();
            stop = start(presented);
        });
        return () => { unsubscribe(); stop?.(); };
    }, [active, scope?.serverId, scope?.accountId, current, artifactIds, presentedSignal]);
    return titles;
}
