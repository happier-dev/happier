import * as React from 'react';
import type { MarketplaceCatalogReferenceV1 } from '@happier-dev/protocol/marketplace';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { usePluginSettingsScreenState, type PluginSettingsScreenState } from '@/components/settings/plugins/model/usePluginSettingsScreenState';
import type { PluginListingRouteParams } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';

export type StorePluginListingState = Readonly<{
    listing: PluginListingRouteParams | null;
    state: PluginSettingsScreenState;
    resolving: boolean;
    error: string | null;
    refresh: () => void;
}>;

/** Resolve native itemId → pluginId through the existing exact catalog read, never a title or source-wide list. */
export function StorePluginListing(props: Readonly<{
    reference: Extract<MarketplaceCatalogReferenceV1, { type: 'registryItem' }>;
    children: (state: StorePluginListingState) => React.ReactNode;
}>): React.ReactNode {
    const focused = useIsFocused();
    const state = usePluginSettingsScreenState({ listing: props.reference, focused });
    const item = state.selectedItem;
    const listing = item?.payload.kind === 'plugin' ? {
        sourceId: item.summary.sourceId, itemId: item.summary.itemId,
        ...('listing' in item.payload
            ? { pluginId: item.payload.listing.pluginId, version: item.payload.listing.distribution.version }
            : { pluginId: item.summary.itemId }),
    } : null;
    return props.children({ listing, state, resolving: state.loadingDiscover, error: state.discoverError,
        refresh: state.refreshDiscover });
}
