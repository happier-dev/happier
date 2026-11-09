import * as React from 'react';
import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import type { StoreListingReference } from '../model/pluginsSurfaceRoutes';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { StorePluginListing } from '@/components/store/StorePluginListing';
import { t } from '@/text';

import { buildPluginsHomeRoute, readStoreListingRoute } from '../model/pluginsSurfaceRoutes';
import { usePluginsSurfaceHost } from '../model/usePluginsSurfaceHost';
import { PluginListingScreen } from './PluginListingScreen';

/**
 * One validated ingress for both hosts. The Store composition supplies its page body;
 * legacy Plugin links and native Plugin refs retain the existing listing screen.
 */
export type PluginListingRouteProps = Readonly<{
    renderStoreListing?: (reference: StoreListingReference) => React.ReactNode;
}>;

export const PluginListingRoute = React.memo<PluginListingRouteProps>(function PluginListingRoute(props) {
    const host = usePluginsSurfaceHost();
    const params = useLocalSearchParams();
    const selection = readStoreListingRoute(params);
    const unavailable = <SurfaceStateCard testID="store.listing.unavailable" kind="unavailable" size="line" title={t('common.unavailable')} />;
    if (!selection) return params.selection !== undefined ? unavailable : <Redirect href={buildPluginsHomeRoute(host)} />;
    if (selection.kind === 'plugin') return <PluginListingScreen {...selection.listing} />;
    if (props.renderStoreListing) return props.renderStoreListing(selection.reference);
    const reference = selection.reference;
    if (reference.type !== 'registryItem' || reference.kind !== 'plugin') return unavailable;
    return <StorePluginListing reference={reference}>{state => state.listing
        ? <PluginListingScreen {...state.listing} />
        : <SurfaceStateCard testID="store.listing.unavailable" kind={state.resolving ? 'loading' : 'unavailable'}
            size="line" title={t(state.resolving ? 'common.loading' : 'common.unavailable')} />}
    </StorePluginListing>;
});
