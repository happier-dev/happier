import React from 'react';
import { Platform, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Text, TextInput } from '@/components/ui/text/Text';
import { layout } from '@/components/ui/layout/layout';
import { AutomationSettingsForm, type AutomationSettingsValue } from '@/components/automations/editor/AutomationSettingsForm';
import { Modal } from '@/modal';
import { useSession } from '@/sync/domains/state/storage';
import { normalizeAutomationDescription, normalizeAutomationName, type AutomationScheduleInput, validateAutomationTemplateTarget } from '@/sync/domains/automations/automationValidation';
import { encodeAutomationTemplateCiphertextForAccount } from '@/sync/domains/automations/encodeAutomationTemplateCiphertextForAccount';
import { sync } from '@/sync/sync';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
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

function buildScheduleFromSettings(form: AutomationSettingsValue): AutomationScheduleInput {
    const timezone = form.timezone ?? null;
    if (form.scheduleKind === 'cron') {
        const scheduleExpr = form.cronExpr.trim().length > 0 ? form.cronExpr.trim() : '0 * * * *';
        return { kind: 'cron', scheduleExpr, timezone };
    }
    const minutes = Math.min(Math.max(Math.floor(form.everyMinutes), 1), 24 * 60);
    return { kind: 'interval', everyMs: minutes * 60_000, timezone };
}

function normalizeDirectory(input: unknown): string {
    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (trimmed.length > 0) return trimmed;
    }
    return '/';
}

export function SessionAutomationCreateScreen(props: { sessionId: string }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const session = useSession(props.sessionId);

    const [message, setMessage] = React.useState('');
    const [form, setForm] = React.useState<AutomationSettingsValue>(() => ({
        enabled: true,
        name: t('automations.create.defaultName'),
        description: '',
        scheduleKind: 'interval',
        everyMinutes: 60,
        cronExpr: '0 * * * *',
        timezone: null,
    }));

    const machineId = typeof session?.metadata?.machineId === 'string' ? session.metadata.machineId : null;
    const sessionDekBase64 = sync.getSessionEncryptionKeyBase64ForResume(props.sessionId);
    const requiresDek = session?.encryptionMode !== 'plain';

    const isValid = React.useMemo(() => {
        const nameOk = form.name.trim().length > 0;
        const scheduleOk = form.scheduleKind === 'interval'
            ? Number.isFinite(form.everyMinutes) && form.everyMinutes >= 1
            : form.cronExpr.trim().length > 0;
        const messageOk = message.trim().length > 0;
        const sessionOk = Boolean(session) && Boolean(machineId) && (!requiresDek || Boolean(sessionDekBase64));
        return nameOk && scheduleOk && messageOk && sessionOk;
    }, [form, machineId, message, requiresDek, session, sessionDekBase64]);

    const handleCreate = React.useCallback(async () => {
        if (!isValid) return;
        if (!session || !machineId) return;
        if (requiresDek && !sessionDekBase64) return;
        try {
            const credentials = sync.getCredentials();
            const template = {
                directory: normalizeDirectory(session.metadata?.path ?? session.metadata?.homeDir),
                prompt: message.trim(),
                displayText: message.trim(),
                existingSessionId: props.sessionId,
                ...(requiresDek && sessionDekBase64
                    ? { sessionEncryptionKeyBase64: sessionDekBase64, sessionEncryptionVariant: 'dataKey' as const }
                    : {}),
            };
            validateAutomationTemplateTarget({
                targetType: 'existing_session',
                template,
            });
            const templateCiphertext = await encodeAutomationTemplateCiphertextForAccount({
                credentials,
                template,
                encryptRaw: (value) => sync.encryption.encryptAutomationTemplateRaw(value),
            });

            await sync.createAutomation({
                name: normalizeAutomationName(form.name),
                description: normalizeAutomationDescription(form.description),
                enabled: form.enabled,
                schedule: buildScheduleFromSettings(form),
                targetType: 'existing_session',
                templateCiphertext,
                assignments: [{ machineId, enabled: true, priority: 100 }],
            });
            await sync.refreshAutomations();
            router.back();
        } catch (error) {
            await Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('automations.create.createFailed')
            );
        }
    }, [form, isValid, machineId, message, props.sessionId, requiresDek, router, session, sessionDekBase64]);

    const missingReason = React.useMemo(() => {
        if (!session) return t('automations.create.sessionNotFound');
        if (!machineId) return t('automations.create.missingMachineId');
        if (requiresDek && !sessionDekBase64) return t('automations.create.missingResumeKey');
        return null;
    }, [machineId, requiresDek, session, sessionDekBase64]);

    return (
        <View style={styles.container}>
            <ItemList style={{ paddingTop: 0 }}>
                <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                    {missingReason ? (
                        <ItemGroup title={t('automations.create.unavailableGroupTitle')}>
                            <Item
                                title={t('automations.create.cannotCreateForSession')}
                                subtitle={missingReason}
                                subtitleLines={0}
                                icon={<Ionicons name="alert-circle-outline" size={29} color={theme.colors.warningCritical} />}
                                showChevron={false}
                            />
                        </ItemGroup>
                    ) : null}

                    <ItemGroup title={t('common.message')}>
                        <View style={styles.contentContainer}>
                            <Text style={styles.label}>{t('automations.edit.messageLabel')}</Text>
                            <TextInput
                                style={styles.textInput}
                                value={message}
                                onChangeText={setMessage}
                                placeholder={t('automations.edit.messagePlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="sentences"
                                autoCorrect={true}
                                multiline={true}
                            />
                            <Text style={styles.helpText}>
                                {t('automations.edit.messageHelpText')}
                            </Text>
                        </View>
                    </ItemGroup>

                    <AutomationSettingsForm
                        variant="new-session"
                        value={form}
                        onChange={setForm}
                    />

                    <ItemGroup title={t('common.actions')}>
                        <Item
                            title={t('automations.create.createButtonTitle')}
                            icon={<Ionicons name="checkmark-circle-outline" size={29} color={theme.colors.success} />}
                            onPress={() => void handleCreate()}
                            disabled={!isValid}
                            showChevron={false}
                        />
                    </ItemGroup>
                </View>
            </ItemList>
        </View>
    );
}
