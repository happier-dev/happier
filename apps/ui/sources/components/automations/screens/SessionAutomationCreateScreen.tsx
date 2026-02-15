import React from 'react';
import { Platform, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/StyledText';
import { layout } from '@/components/ui/layout/layout';
import { AutomationSettingsForm, type AutomationSettingsValue } from '@/components/automations/editor/AutomationSettingsForm';
import { Modal } from '@/modal';
import { useSession } from '@/sync/domains/state/storage';
import { normalizeAutomationDescription, normalizeAutomationName, type AutomationScheduleInput, validateAutomationTemplateTarget } from '@/sync/domains/automations/automationValidation';
import { sealAutomationTemplateForTransport } from '@/sync/domains/automations/automationTemplateTransport';
import { sync } from '@/sync/sync';

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
        name: 'Scheduled message',
        description: '',
        scheduleKind: 'interval',
        everyMinutes: 60,
        cronExpr: '0 * * * *',
        timezone: null,
    }));

    const machineId = typeof session?.metadata?.machineId === 'string' ? session.metadata.machineId : null;
    const sessionDekBase64 = sync.getSessionEncryptionKeyBase64ForResume(props.sessionId);

    const isValid = React.useMemo(() => {
        const nameOk = form.name.trim().length > 0;
        const scheduleOk = form.scheduleKind === 'interval'
            ? Number.isFinite(form.everyMinutes) && form.everyMinutes >= 1
            : form.cronExpr.trim().length > 0;
        const messageOk = message.trim().length > 0;
        const sessionOk = Boolean(session) && Boolean(machineId) && Boolean(sessionDekBase64);
        return nameOk && scheduleOk && messageOk && sessionOk;
    }, [form, machineId, message, session, sessionDekBase64]);

    const handleCreate = React.useCallback(async () => {
        if (!isValid) return;
        if (!session || !machineId || !sessionDekBase64) return;
        try {
            const template = {
                directory: normalizeDirectory(session.metadata?.path ?? session.metadata?.homeDir),
                prompt: message.trim(),
                displayText: message.trim(),
                existingSessionId: props.sessionId,
                sessionEncryptionKeyBase64: sessionDekBase64,
                sessionEncryptionVariant: 'dataKey' as const,
            };
            validateAutomationTemplateTarget({
                targetType: 'existing_session',
                template,
            });
            const templateCiphertext = await sealAutomationTemplateForTransport({
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
            await Modal.alert('Error', error instanceof Error ? error.message : 'Failed to create automation.');
        }
    }, [form, isValid, machineId, message, props.sessionId, router, session, sessionDekBase64]);

    const missingReason = React.useMemo(() => {
        if (!session) return 'Session not found.';
        if (!machineId) return 'This session is missing a machine id.';
        if (!sessionDekBase64) return 'This session does not have a resume encryption key loaded yet.';
        return null;
    }, [machineId, session, sessionDekBase64]);

    return (
        <View style={styles.container}>
            <ItemList style={{ paddingTop: 0 }}>
                <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                    {missingReason ? (
                        <ItemGroup title="Unavailable">
                            <Item
                                title="Cannot create automation for this session"
                                subtitle={missingReason}
                                subtitleLines={0}
                                icon={<Ionicons name="alert-circle-outline" size={29} color="#FF3B30" />}
                                showChevron={false}
                            />
                        </ItemGroup>
                    ) : null}

                    <ItemGroup title="Message">
                        <View style={styles.contentContainer}>
                            <Text style={styles.label}>MESSAGE</Text>
                            <TextInput
                                style={styles.textInput}
                                value={message}
                                onChangeText={setMessage}
                                placeholder="Message to send"
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="sentences"
                                autoCorrect={true}
                                multiline={true}
                            />
                            <Text style={styles.helpText}>
                                This message will be queued into the session as a pending user message.
                            </Text>
                        </View>
                    </ItemGroup>

                    <AutomationSettingsForm
                        variant="new-session"
                        value={form}
                        onChange={setForm}
                    />

                    <ItemGroup title="Actions">
                        <Item
                            title="Create automation"
                            icon={<Ionicons name="checkmark-circle-outline" size={29} color="#34C759" />}
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
