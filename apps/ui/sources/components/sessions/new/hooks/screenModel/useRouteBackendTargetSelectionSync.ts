import React from 'react';
import type { BackendTargetRefV2, PersistedBackendTargetRefV2 } from '@happier-dev/protocol';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

export function useRouteBackendTargetSelectionSync(params: Readonly<{
    routeBackendTarget: PersistedBackendTargetRefV2 | null;
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    selectedBackendTargetKey: string;
    setBackendTarget: (next: React.SetStateAction<PersistedBackendTargetRefV2>) => void;
}>): void {
    const routeBackendTargetKey = React.useMemo(() => {
        return params.routeBackendTarget ? resolveBackendTargetKeyV2(params.routeBackendTarget) : null;
    }, [params.routeBackendTarget]);

    const lastAppliedRouteBackendTargetKeyRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!params.routeBackendTarget || !routeBackendTargetKey) {
            lastAppliedRouteBackendTargetKeyRef.current = null;
            return;
        }
        if (lastAppliedRouteBackendTargetKeyRef.current === routeBackendTargetKey) {
            return;
        }
        const matchedRouteEntry = params.resolvedBackendEntries.find((entry) => entry.backendTargetKey === routeBackendTargetKey) ?? null;
        if (!matchedRouteEntry) {
            return;
        }
        lastAppliedRouteBackendTargetKeyRef.current = routeBackendTargetKey;
        if (routeBackendTargetKey === params.selectedBackendTargetKey) {
            return;
        }
        params.setBackendTarget(matchedRouteEntry.backendTarget);
    }, [
        params.resolvedBackendEntries,
        params.routeBackendTarget,
        params.selectedBackendTargetKey,
        params.setBackendTarget,
        routeBackendTargetKey,
    ]);
}
