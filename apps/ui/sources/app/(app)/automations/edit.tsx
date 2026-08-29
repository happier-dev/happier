import { Stack, useLocalSearchParams } from 'expo-router';

import { AutomationsGate } from '@/components/automations/gating/AutomationsGate';
import { AutomationEditorHostScreen } from '@/components/automations/screens/AutomationEditorHostScreen';
import {
    parseExactTurnAutomationPrefillRoute,
} from '@/components/automations/sessionLifecycle/exactTurnAutomationPrefill';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

export default function AutomationEditRoute() {
    const params = useLocalSearchParams<{
        id?: string;
        sourceSessionId?: string;
        sourceTurnId?: string;
        sourceServerId?: string;
    }>();
    const automationId = typeof params.id === 'string' ? params.id.trim() : '';
    const exactTurnRoute = parseExactTurnAutomationPrefillRoute(params);

    return (
        <AutomationsGate>
            <Stack.Screen options={{ title: t('automations.edit.title'), headerBackTitle: t('common.back') }} />
            {exactTurnRoute.kind === 'invalid' ? (
                <SurfaceStateCard
                    testID="automation-edit-exact-turn-invalid"
                    kind="error"
                    title={t('common.error')}
                    reason={t('automations.exactTurn.unavailable')}
                    accessibilitySemantics="alert"
                />
            ) : (
                <AutomationEditorHostScreen
                    automationId={automationId}
                    exactTurnPrefill={exactTurnRoute.kind === 'valid' ? exactTurnRoute.prefill : null}
                />
            )}
        </AutomationsGate>
    );
}
