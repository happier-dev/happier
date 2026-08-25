import React from 'react';

import { AutomationsGate } from '@/components/automations/gating/AutomationsGate';
import { AutomationSettingsScreen } from '@/components/automations/screens/AutomationSettingsScreen';

export default function AutomationSettingsRoute() {
    return (
        <AutomationsGate>
            <AutomationSettingsScreen />
        </AutomationsGate>
    );
}
