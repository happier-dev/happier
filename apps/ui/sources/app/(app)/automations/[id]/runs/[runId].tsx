import React from 'react';

import { AutomationsGate } from '@/components/automations/gating/AutomationsGate';
import { AutomationRunDetailScreen } from '@/components/automations/screens/AutomationRunDetailScreen';

export default function AutomationRunDetailRoute() {
    return (
        <AutomationsGate>
            <AutomationRunDetailScreen />
        </AutomationsGate>
    );
}
