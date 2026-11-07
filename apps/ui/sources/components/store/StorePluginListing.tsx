import * as React from 'react';
import type { MarketplaceCatalogReferenceV1 } from '@happier-dev/protocol/marketplace';
import { usePluginCatalog } from '@/components/settings/plugins/model/usePluginCatalog';
import type { PluginListingRouteParams } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';

export type StorePluginListingState = Readonly<{
    listing: PluginListingRouteParams | null;
    resolving: boolean;
    error: string | null;
    refresh: () => void;
}>;

/** Resolve native itemId → pluginId through the existing exact catalog read, never a title or source-wide list. */
export function StorePluginListing(props: Readonly<{
    reference: Extract<MarketplaceCatalogReferenceV1, { type: 'registryItem' }>;
    children: (state: StorePluginListingState) => React.ReactNode;
}>): React.ReactNode {
    const catalog = usePluginCatalog({ selection: props.reference });
    const item = catalog.selectedItem;
    const listing = item?.payload.kind === 'plugin' ? {
        sourceId: item.summary.sourceId, itemId: item.summary.itemId,
        pluginId: item.payload.listing.pluginId, version: item.payload.listing.distribution.version,
    } : null;
    return props.children({ listing, resolving: catalog.loadingDiscover, error: catalog.discoverError,
        refresh: catalog.refreshDiscover });
}
