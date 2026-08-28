import * as React from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';

import { AutomationsGate } from '@/components/automations/gating/AutomationsGate';
import { AutomationEditorHostScreen } from '@/components/automations/screens/AutomationEditorHostScreen';
import { parseExactTurnAutomationPrefill } from '@/components/automations/sessionLifecycle/exactTurnAutomationPrefill';
import { t } from '@/text';

export default function AutomationEditRoute() {
    const params = useLocalSearchParams<{
        id?: string;
        sourceSessionId?: string;
        sourceTurnId?: string;
        sourceServerId?: string;
    }>();
    const automationId = typeof params.id === 'string' ? params.id.trim() : '';
    const exactTurnPrefill = React.useMemo(() => parseExactTurnAutomationPrefill(params), [
        params.sourceServerId,
        params.sourceSessionId,
        params.sourceTurnId,
    ]);

    return (
        <AutomationsGate>
            <Stack.Screen options={{ title: t('automations.edit.title'), headerBackTitle: t('common.back') }} />
            <AutomationEditorHostScreen
                automationId={automationId}
                exactTurnPrefill={exactTurnPrefill}
            />
        </AutomationsGate>
    );
}
