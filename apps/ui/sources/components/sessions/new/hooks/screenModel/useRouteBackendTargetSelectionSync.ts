import React from 'react';
import { buildBackendTargetKey, type BackendTargetRefV1 } from '@happier-dev/protocol';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';

export function useRouteBackendTargetSelectionSync(params: Readonly<{
    routeBackendTarget: BackendTargetRefV1 | null;
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    selectedBackendTargetKey: string;
    setBackendTarget: (next: React.SetStateAction<BackendTargetRefV1>) => void;
}>): void {
    const routeBackendTargetKey = React.useMemo(() => {
        return params.routeBackendTarget ? buildBackendTargetKey(params.routeBackendTarget) : null;
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
        const matchedRouteEntry = params.resolvedBackendEntries.find((entry) => entry.targetKey === routeBackendTargetKey) ?? null;
        if (!matchedRouteEntry) {
            return;
        }
        lastAppliedRouteBackendTargetKeyRef.current = routeBackendTargetKey;
        if (routeBackendTargetKey === params.selectedBackendTargetKey) {
            return;
        }
        params.setBackendTarget(matchedRouteEntry.target);
    }, [
        params.resolvedBackendEntries,
        params.routeBackendTarget,
        params.selectedBackendTargetKey,
        params.setBackendTarget,
        routeBackendTargetKey,
    ]);
}
