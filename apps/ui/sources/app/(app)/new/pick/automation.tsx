import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { CommonActions } from '@react-navigation/native';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { AutomationsGate } from '@/components/automations/gating/AutomationsGate';
import { ItemList } from '@/components/ui/lists/ItemList';
import { AutomationSettingsForm } from '@/components/automations/editor/AutomationSettingsForm';
import { DEFAULT_NEW_SESSION_AUTOMATION_DRAFT, sanitizeNewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import { t } from '@/text';
import { layout } from '@/components/ui/layout/layout';

type AutomationPickerParams = Readonly<{
    automationEnabled?: string;
    automationName?: string;
    automationDescription?: string;
    automationScheduleKind?: string;
    automationEveryMinutes?: string;
    automationCronExpr?: string;
    automationTimezone?: string;
}>;

function parseBoolParam(input: string | undefined): boolean | undefined {
    if (typeof input !== 'string') return undefined;
    const normalized = input.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return undefined;
}

function toNumberParam(value: number): string {
    return String(value);
}

export default React.memo(function AutomationPickerScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<AutomationPickerParams>();

    const [draft, setDraft] = React.useState(() => {
        const parsed = sanitizeNewSessionAutomationDraft({
            enabled: parseBoolParam(params.automationEnabled),
            name: params.automationName,
            description: params.automationDescription,
            scheduleKind: params.automationScheduleKind,
            everyMinutes: typeof params.automationEveryMinutes === 'string'
                ? Number.parseInt(params.automationEveryMinutes, 10)
                : undefined,
            cronExpr: params.automationCronExpr,
            timezone: params.automationTimezone,
        });
        return { ...DEFAULT_NEW_SESSION_AUTOMATION_DRAFT, ...parsed };
    });

    const isValid = React.useMemo(() => {
        if (!draft.enabled) return true;
        const nameOk = draft.name.trim().length > 0;
        const scheduleOk = draft.scheduleKind === 'interval'
            ? Number.isFinite(draft.everyMinutes) && draft.everyMinutes >= 1
            : draft.cronExpr.trim().length > 0;
        return nameOk && scheduleOk;
    }, [draft]);

    const setParamsOnPreviousAndClose = React.useCallback((next: typeof draft) => {
        const state = navigation.getState();
        const previousRoute = state?.routes?.[state.index - 1];
        if (state && state.index > 0 && previousRoute) {
            navigation.dispatch({
                ...CommonActions.setParams({
                    automationEnabled: next.enabled ? '1' : '0',
                    automationName: next.name,
                    automationDescription: next.description,
                    automationScheduleKind: next.scheduleKind,
                    automationEveryMinutes: toNumberParam(next.everyMinutes),
                    automationCronExpr: next.cronExpr,
                    automationTimezone: next.timezone ?? '',
                }),
                source: previousRoute.key,
            });
        }
        router.back();
    }, [navigation, router]);

    const handleSave = React.useCallback(() => {
        if (!isValid) return;
        setParamsOnPreviousAndClose(draft);
    }, [draft, isValid, setParamsOnPreviousAndClose]);

    const headerLeft = React.useCallback(() => (
        <Pressable
            onPress={() => router.back()}
            hitSlop={10}
            style={({ pressed }) => ({ padding: 2, opacity: pressed ? 0.7 : 1 })}
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
        >
            <Ionicons name="chevron-back" size={22} color={theme.colors.header.tint} />
        </Pressable>
    ), [router, theme.colors.header.tint]);

    const headerRight = React.useCallback(() => (
        <Pressable
            onPress={handleSave}
            disabled={!isValid}
            hitSlop={10}
            style={({ pressed }) => ({ padding: 2, opacity: !isValid ? 0.4 : pressed ? 0.7 : 1 })}
            accessibilityRole="button"
            accessibilityLabel="Save automation settings"
        >
            <Ionicons name="checkmark" size={22} color={theme.colors.header.tint} />
        </Pressable>
    ), [handleSave, isValid, theme.colors.header.tint]);

    const screenOptions = React.useMemo(() => ({
        headerShown: true,
        title: 'Automation',
        headerBackTitle: t('common.back'),
        presentation: Platform.OS === 'ios' ? ('containedModal' as const) : undefined,
        headerLeft,
        headerRight,
    }), [headerLeft, headerRight]);

    return (
        <AutomationsGate>
            <>
                <Stack.Screen options={screenOptions} />
                <ItemList>
                    <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                        <AutomationSettingsForm
                            variant="new-session"
                            value={draft}
                            onChange={(next) => setDraft(next)}
                        />
                    </View>
                </ItemList>
            </>
        </AutomationsGate>
    );
});
