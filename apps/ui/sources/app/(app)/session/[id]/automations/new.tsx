import React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { AutomationsGate } from '@/components/automations/gating/AutomationsGate';
import { SessionAutomationCreateScreen } from '@/components/automations/screens/SessionAutomationCreateScreen';

export default function SessionAutomationCreateRoute() {
    const params = useLocalSearchParams<{ id?: string }>();
    const sessionId = typeof params.id === 'string' ? params.id : '';
    return (
        <AutomationsGate>
            <SessionAutomationCreateScreen sessionId={sessionId} />
        </AutomationsGate>
    );
}
