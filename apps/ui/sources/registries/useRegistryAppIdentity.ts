import * as React from 'react';
import { registryContentRefEqualV1, type RegistryItemV1 } from '@happier-dev/protocol/registries';
import type { DeploymentTemplateRefV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import type { HostCatalogMark } from '@/components/ui/media/HappierBrandMark';
import { admitRegistrySummaryMark } from './registryBrandMark';
import { useRegistryItem } from './useRegistryItem';

/** Exact catalog identity; an unavailable or superseded source never borrows another App's mark. */
export function registryAppIdentity(item: RegistryItemV1 | null, pin: DeploymentTemplateRefV1): Readonly<{ title: string; mark: HostCatalogMark }> | null {
    if (!item || item.summary.kind !== 'app' || item.payload.kind !== 'app'
        || item.summary.sourceId !== pin.sourceId || item.summary.itemId !== pin.itemId
        || item.summary.version !== pin.version || !registryContentRefEqualV1(item.payload.ref, pin.ref)) return null;
    const summary = admitRegistrySummaryMark(item.summary);
    return { title: summary.title, mark: summary.brandMark! };
}

/** Environment/list/Service callers pass their saved template pin and render the shared HappierBrandMark. */
export function useRegistryAppIdentity(pin: DeploymentTemplateRefV1 | null | undefined, presented: boolean) {
    const read = useRegistryItem({ kind: 'app', sourceId: pin?.sourceId ?? '', itemId: pin?.itemId ?? '',
        ...(pin ? { version: pin.version } : {}) }, presented && !!pin);
    const identity = React.useMemo(() => pin && !read.stale ? registryAppIdentity(read.item, pin) : null,
        [pin, read.item, read.stale]);
    return { identity, loading: !!pin && read.loading, stale: read.stale, error: read.error, status: read.status, refresh: read.refresh };
}
