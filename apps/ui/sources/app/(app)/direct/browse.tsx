import * as React from 'react';
import { Redirect } from 'expo-router';

import { ExternalSessionsBrowseRouteGate } from '@/components/sessions/external/browse/ExternalSessionsBrowseRouteGate';

export default React.memo(function LegacyExternalSessionsBrowseRoute() {
    return (
        <ExternalSessionsBrowseRouteGate>
            <Redirect href="/external/browse" />
        </ExternalSessionsBrowseRouteGate>
    );
});
