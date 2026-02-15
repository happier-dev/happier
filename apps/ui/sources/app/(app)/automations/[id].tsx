import React from 'react';

import { AutomationsGate } from '@/components/automations/gating/AutomationsGate';
import { AutomationDetailScreen } from '@/components/automations/screens/AutomationDetailScreen';

export default function AutomationDetailRoute() {
    return (
        <AutomationsGate>
            <AutomationDetailScreen />
        </AutomationsGate>
    );
}
