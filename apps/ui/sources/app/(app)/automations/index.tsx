import React from 'react';

import { AutomationsGate } from '@/components/automations/gating/AutomationsGate';
import { AutomationsScreen } from '@/components/automations/screens/AutomationsScreen';

export default function AutomationsIndexRoute() {
    return (
        <AutomationsGate>
            <AutomationsScreen />
        </AutomationsGate>
    );
}
