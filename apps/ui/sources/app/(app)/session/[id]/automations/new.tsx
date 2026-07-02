import React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { AutomationsGate } from '@/components/automations/gating/AutomationsGate';
import { SessionAutomationCreateScreen } from '@/components/automations/screens/SessionAutomationCreateScreen';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';

export default function SessionAutomationCreateRoute() {
    const params = useLocalSearchParams<{ id?: string | string[]; serverId?: string | string[] }>();
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params as Record<string, unknown>), [params]);
    const sessionId = normalizeSessionId(params.id);
    return (
        <AutomationsGate>
            <SessionAutomationCreateScreen sessionId={sessionId} hydrationOptions={routeScope.hydrationOptions} />
        </AutomationsGate>
    );
}
