import * as React from 'react';

import { SettingsCollectionLayout } from '@/components/settings/shell/SettingsCollectionLayout';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';

import { ConnectedServicesRail } from './ConnectedServicesRail';
import { CONNECTED_SERVICES_COLLECTION_ROUTE, resolveConnectedServicesChildRoute } from './connectedServicesCollectionRoutes';

/** The narrowest detail that still fits an account's identity beside its meters. */
const CONNECTED_SERVICES_DETAIL_MIN_WIDTH_PX = 560;

/**
 * Connected services as a collection (lab `csvc` C1): the rail of services (each expanding to its
 * accounts), pools and code hosts beside the detail. With nothing selected the detail is the index of
 * every service (a designed overview, `COLLECTION-REQUIREMENTS.md` §2.1 exception); selecting an account
 * or a pool opens it. Narrow: the index page is the list and pushes each detail.
 */
export const ConnectedServicesSettingsLayout = React.memo(function ConnectedServicesSettingsLayout() {
    const presented = useLayoutPresentationActive();
    return (
        <SettingsCollectionLayout
            navigator="connected-services"
            rootPathname={CONNECTED_SERVICES_COLLECTION_ROUTE}
            resolveChildRoute={resolveConnectedServicesChildRoute}
            // The column shows from the first visit (R6-2), so "+" is always in one place.
            rail={<RetainedPanelSurface isActive={presented} suspendWhenHidden>
                <ConnectedServicesRail />
            </RetainedPanelSurface>}
            railWidth="standard"
            detailMinWidthPx={CONNECTED_SERVICES_DETAIL_MIN_WIDTH_PX}
            testID="settings-connected-services"
        />
    );
});
