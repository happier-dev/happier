import React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { AutomationsGate } from '@/components/automations/gating/AutomationsGate';
import { SessionAutomationsScreen } from '@/components/automations/screens/SessionAutomationsScreen';

export default function SessionAutomationsRoute() {
    const params = useLocalSearchParams<{ id?: string }>();
    const sessionId = typeof params.id === 'string' ? params.id : '';
    return (
        <AutomationsGate>
            <SessionAutomationsScreen sessionId={sessionId} />
        </AutomationsGate>
    );
}
