import React from 'react';

import ExternalSessionsSettingsView from '@/components/settings/externalSessions/ExternalSessionsSettingsView';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

export default React.memo(function ExternalSessionsSettingsRoute() {
    const enabled = useFeatureEnabled('sessions.direct');

    if (!enabled) {
        return null;
    }

    return (
        <ExternalSessionsSettingsView integrationInventoryEnabled={true} />
    );
});
