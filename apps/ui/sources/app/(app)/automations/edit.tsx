import React from 'react';
import { Platform, Pressable, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { AutomationsGate } from '@/components/automations/gating/AutomationsGate';
import { AutomationSettingsForm, type AutomationSettingsValue } from '@/components/automations/editor/AutomationSettingsForm';
import { Modal } from '@/modal';
import { useAutomation } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { layout } from '@/components/ui/layout/layout';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/StyledText';
import { updateExistingSessionAutomationTemplateMessage } from '@/sync/domains/automations/automationExistingSessionTemplateUpdate';
import { tryDecodeAutomationTemplateEnvelope } from '@/sync/domains/automations/automationTemplateTransport';
import { decodeAutomationTemplate } from '@/sync/domains/automations/automationTemplateCodec';

export default React.memo(function AutomationEditScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const params = useLocalSearchParams<{ id?: string }>();
    const automationId = typeof params.id === 'string' ? params.id : '';
    const automation = useAutomation(automationId);

    const [form, setForm] = React.useState<AutomationSettingsValue>(() => ({
        enabled: false,
        name: '',
        description: '',
        scheduleKind: 'interval',
        everyMinutes: 60,
        cronExpr: '0 * * * *',
        timezone: null,
    }));
    const [message, setMessage] = React.useState('');
    const [messageLoading, setMessageLoading] = React.useState(false);
    const initializedRef = React.useRef(false);

    React.useEffect(() => {
        if (!automation || initializedRef.current) return;
        initializedRef.current = true;
        const everyMinutes = automation.schedule.kind === 'interval' && typeof automation.schedule.everyMs === 'number'
            ? Math.max(1, Math.round(automation.schedule.everyMs / 60_000))
            : 60;
        const cronExpr = automation.schedule.kind === 'cron' && typeof automation.schedule.scheduleExpr === 'string'
            ? automation.schedule.scheduleExpr
            : '0 * * * *';
        setForm({
            enabled: automation.enabled,
            name: automation.name,
            description: automation.description ?? '',
            scheduleKind: automation.schedule.kind,
            timezone: automation.schedule.timezone ?? null,
            everyMinutes,
            cronExpr,
        });
    }, [automation]);

    React.useEffect(() => {
        if (!automation || automation.targetType !== 'existing_session') return;
        let alive = true;
        void (async () => {
            try {
                setMessageLoading(true);
                const envelope = tryDecodeAutomationTemplateEnvelope(automation.templateCiphertext);
                if (!envelope) {
                    throw new Error('Invalid encrypted automation template envelope payload');
                }
                const raw = await sync.encryption.decryptAutomationTemplateRaw(envelope.payloadCiphertext);
                const decoded = decodeAutomationTemplate(JSON.stringify(raw));
                if (!decoded) {
                    throw new Error('Invalid decrypted automation template payload');
                }
                const initial = (decoded.prompt ?? decoded.displayText ?? '').trim();
                if (!alive) return;
                setMessage(initial);
            } catch (error) {
                if (!alive) return;
                await Modal.alert('Error', error instanceof Error ? error.message : 'Failed to load automation template.');
            } finally {
                if (!alive) return;
                setMessageLoading(false);
            }
        })();
        return () => {
            alive = false;
        };
    }, [automation]);

    const isValid = React.useMemo(() => {
        const nameOk = form.name.trim().length > 0;
        const scheduleOk = form.scheduleKind === 'interval'
            ? Number.isFinite(form.everyMinutes) && form.everyMinutes >= 1
            : form.cronExpr.trim().length > 0;
        const messageOk = automation?.targetType !== 'existing_session' || message.trim().length > 0;
        return nameOk && scheduleOk && messageOk && !messageLoading;
    }, [automation?.targetType, form, message, messageLoading]);

    const handleSave = React.useCallback(async () => {
        if (!automationId || !automation) return;
        if (!isValid) return;
        try {
            const templateCiphertext = automation.targetType === 'existing_session'
                ? await updateExistingSessionAutomationTemplateMessage({
                    templateCiphertext: automation.templateCiphertext,
                    message,
                    decryptRaw: (payloadCiphertext) => sync.encryption.decryptAutomationTemplateRaw(payloadCiphertext),
                    encryptRaw: (value) => sync.encryption.encryptAutomationTemplateRaw(value),
                })
                : undefined;
            await sync.updateAutomation(automationId, {
                enabled: form.enabled,
                name: form.name.trim() || automation.name,
                description: form.description.trim().length > 0 ? form.description.trim() : null,
                schedule: form.scheduleKind === 'interval'
                    ? {
                        kind: 'interval',
                        everyMs: Math.min(Math.max(Math.floor(form.everyMinutes), 1), 24 * 60) * 60_000,
                        timezone: form.timezone ?? null,
                    }
                    : {
                        kind: 'cron',
                        scheduleExpr: form.cronExpr.trim(),
                        timezone: form.timezone ?? null,
                    },
                ...(templateCiphertext ? { templateCiphertext } : {}),
            });
            await sync.refreshAutomations();
            router.back();
        } catch (error) {
            await Modal.alert('Error', error instanceof Error ? error.message : 'Failed to update automation.');
        }
    }, [automation, automationId, form, isValid, router]);

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
            onPress={() => { void handleSave(); }}
            disabled={!isValid}
            hitSlop={10}
            style={({ pressed }) => ({ padding: 2, opacity: !isValid ? 0.4 : pressed ? 0.7 : 1 })}
            accessibilityRole="button"
            accessibilityLabel="Save automation"
        >
            <Ionicons name="checkmark" size={22} color={theme.colors.header.tint} />
        </Pressable>
    ), [handleSave, isValid, theme.colors.header.tint]);

    const screenOptions = React.useMemo(() => ({
        headerShown: true,
        title: 'Edit automation',
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
                        {automation?.targetType === 'existing_session' ? (
                            <ItemGroup title="Message">
                                <View style={stylesMessage.contentContainer}>
                                    <Text style={stylesMessage.label}>MESSAGE</Text>
                                    <TextInput
                                        style={stylesMessage.textInput}
                                        value={message}
                                        onChangeText={setMessage}
                                        placeholder="Message to send"
                                        placeholderTextColor={theme.colors.input.placeholder}
                                        autoCapitalize="sentences"
                                        autoCorrect={true}
                                        multiline={true}
                                        editable={!messageLoading}
                                    />
                                    <Text style={stylesMessage.helpText}>
                                        This message will be queued into the session as a pending user message.
                                    </Text>
                                </View>
                            </ItemGroup>
                        ) : null}
                        <AutomationSettingsForm
                            variant="edit"
                            value={form}
                            onChange={(next) => setForm(next)}
                        />
                    </View>
                </ItemList>
            </>
        </AutomationsGate>
    );
});

const stylesMessage = StyleSheet.create((theme) => ({
    contentContainer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 12,
    },
    label: {
        fontSize: 12,
        fontWeight: '700',
        color: theme.colors.textSecondary,
        letterSpacing: 0.6,
        marginBottom: 6,
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ ios: 10, default: 12 }),
        borderWidth: 0.5,
        borderColor: theme.colors.divider,
        color: theme.colors.text,
    },
    helpText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 6,
    },
}));
