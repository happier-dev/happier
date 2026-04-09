import React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { AutomationsGate } from '@/components/automations/gating/AutomationsGate';
import { SessionAutomationsScreen } from '@/components/automations/screens/SessionAutomationsScreen';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';

export default function SessionAutomationsRoute() {
    const params = useLocalSearchParams<{ id?: string | string[] }>();
    const sessionId = normalizeSessionId(params.id);
    return (
        <AutomationsGate>
            <SessionAutomationsScreen sessionId={sessionId} />
        </AutomationsGate>
    );
}
