import React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { AutomationsGate } from '@/components/automations/gating/AutomationsGate';
import { SessionAutomationCreateScreen } from '@/components/automations/screens/SessionAutomationCreateScreen';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';

export default function SessionAutomationCreateRoute() {
    const params = useLocalSearchParams<{ id?: string | string[] }>();
    const sessionId = normalizeSessionId(params.id);
    return (
        <AutomationsGate>
            <SessionAutomationCreateScreen sessionId={sessionId} />
        </AutomationsGate>
    );
}
