import * as React from 'react';

import ExternalSessionsSettingsView from '@/components/settings/externalSessions/ExternalSessionsSettingsView';
import { ExternalSessionsBrowseRouteGate } from '@/components/sessions/external/browse/ExternalSessionsBrowseRouteGate';

/**
 * The canonical route-admission owner for External Sessions Settings. Checking,
 * probe-failure/unknown, and genuinely disabled decisions each render as an
 * accessible, exitable gate state — never a blank screen — and the Settings
 * children (and therefore their RPCs) mount only once admitted.
 */
export default React.memo(function ExternalSessionsSettingsRoute() {
    return (
        <ExternalSessionsBrowseRouteGate>
            <ExternalSessionsSettingsView integrationInventoryEnabled={true} />
        </ExternalSessionsBrowseRouteGate>
    );
});
