import React from 'react';
import { useLocalSearchParams } from 'expo-router';

import ExternalSessionsSettingsView from '@/components/settings/externalSessions/ExternalSessionsSettingsView';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

export default React.memo(function ExternalSessionsSettingsRoute() {
    const enabled = useFeatureEnabled('sessions.direct');
    const params = useLocalSearchParams<{
        machineId?: string | string[];
    }>();
    const machineIdParam = Array.isArray(params.machineId)
        ? params.machineId[0]
        : params.machineId;
    const initialMachineId = machineIdParam?.trim() || null;

    if (!enabled) {
        return null;
    }

    return (
        <ExternalSessionsSettingsView
            integrationInventoryEnabled={true}
            initialMachineId={initialMachineId}
        />
    );
});
