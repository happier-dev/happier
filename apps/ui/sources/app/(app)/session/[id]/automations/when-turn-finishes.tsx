import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { AutomationsGate } from '@/components/automations/gating/AutomationsGate';
import { ExactTurnAutomationDestinationScreen } from '@/components/automations/sessionLifecycle/ExactTurnAutomationDestinationScreen';
import { parseExactTurnAutomationPrefill } from '@/components/automations/sessionLifecycle/exactTurnAutomationPrefill';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

export default function ExactTurnAutomationDestinationRoute() {
    const params = useLocalSearchParams<{
        id?: string;
        sourceSessionId?: string;
        sourceTurnId?: string;
        sourceServerId?: string;
    }>();
    const observed = parseExactTurnAutomationPrefill(params);
    const routeSessionId = typeof params.id === 'string' ? params.id : null;

    return (
        <AutomationsGate>
            {observed && observed.sourceSessionId === routeSessionId ? (
                <ExactTurnAutomationDestinationScreen observed={observed} />
            ) : (
                <SurfaceStateCard
                    kind="error"
                    title={t('common.error')}
                    reason={t('automations.exactTurn.unavailable')}
                    accessibilitySemantics="alert"
                />
            )}
        </AutomationsGate>
    );
}
