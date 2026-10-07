import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { CustomModalInjectedProps } from '@/modal/types';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import {
    formatSessionReminderPresetRuleLabel,
    SessionReminderPresetConflictError,
    sessionReminderPresetRuleKey,
    type SessionReminderPresetV1,
} from '@/sync/domains/session/organization/sessionReminderPreset';
import { t } from '@/text';
import { motionTokens } from '@/components/ui/motion/motionTokens';

function moveItem(items: readonly SessionReminderPresetV1[], from: number, to: number): SessionReminderPresetV1[] {
    if (to < 0 || to >= items.length) return [...items];
    const next = [...items];
    const [item] = next.splice(from, 1);
    if (!item) return next;
    next.splice(to, 0, item);
    return next;
}

export function SessionReminderPresetManagerModal(props: Readonly<{
    presets: readonly SessionReminderPresetV1[];
    onSubmit: (value: SessionReminderPresetV1[]) => Promise<void>;
    onResolve: (value: SessionReminderPresetV1[] | null) => void;
}> & CustomModalInjectedProps) {
    const { theme } = useUnistyles();
    const [drafts, setDrafts] = React.useState<SessionReminderPresetV1[]>(() => [...props.presets]);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const finish = React.useCallback((value: SessionReminderPresetV1[] | null) => {
        props.onResolve(value);
        props.onClose();
    }, [props]);
    const footer = React.useMemo(() => (
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10 }}>
            <RoundButton display="inverted" title={t('common.cancel')} disabled={saving} onPress={() => finish(null)} />
            <RoundButton title={t('common.save')} disabled={saving} loading={saving} onPress={() => {
                if (saving) return;
                setSaving(true);
                setError(null);
                void props.onSubmit(drafts).then(() => finish(drafts), (cause: unknown) => {
                    setSaving(false);
                    setError(cause instanceof SessionReminderPresetConflictError
                        ? t('sessionsList.reminders.presetsChanged')
                        : t('sessionsList.reminders.presetsSaveFailed'));
                });
            }} />
        </View>
    ), [drafts, finish, props.onSubmit, saving]);

    useModalCardChrome(props.setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        title: t('sessionsList.reminders.managePresets'),
        subtitle: t('sessionsList.reminders.managePresetsMessage'),
        testID: 'session-reminder-preset-manager-modal',
        dimensions: { width: 560, maxHeightRatio: 0.86, size: 'md' as const },
        footer,
    }), [footer]));

    const updateLabel = React.useCallback((index: number, label: string) => {
        setDrafts((current) => current.map((preset, presetIndex) => presetIndex === index
            ? { rule: preset.rule, ...(label.trim().length > 0 ? { label } : {}) }
            : preset));
    }, []);

    return (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }} keyboardShouldPersistTaps="handled">
            {drafts.map((preset, index) => {
                const effectivePresetLabel = preset.label?.trim() || formatSessionReminderPresetRuleLabel(preset.rule);
                return (
                <View
                    key={sessionReminderPresetRuleKey(preset.rule)}
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                        padding: 10,
                        borderRadius: 14,
                        borderWidth: 1,
                        borderColor: theme.colors.border.default,
                        backgroundColor: theme.colors.surface.base,
                    }}
                >
                    <View style={{ flex: 1, gap: 4 }}>
                        <TextInput
                            editable={!saving}
                            value={preset.label ?? ''}
                            placeholder={formatSessionReminderPresetRuleLabel(preset.rule)}
                            placeholderTextColor={theme.colors.text.secondary}
                            accessibilityLabel={t('sessionsList.reminders.renamePresetLabel', { preset: effectivePresetLabel })}
                            onChangeText={(value) => updateLabel(index, value)}
                            style={{ ...Typography.default('semiBold'), color: theme.colors.text.primary, paddingVertical: 5, paddingHorizontal: 7 }}
                        />
                        <Text style={{ color: theme.colors.text.secondary, fontSize: 12, paddingHorizontal: 7 }}>
                            {formatSessionReminderPresetRuleLabel(preset.rule)}
                        </Text>
                    </View>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('sessionsList.reminders.movePresetUpLabel', { preset: effectivePresetLabel })}
                        disabled={saving || index === 0}
                        onPress={() => setDrafts((current) => moveItem(current, index, index - 1))}
                        style={({ pressed }) => ({ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', opacity: index === 0 ? 0.28 : pressed ? motionTokens.press.opacity : 1 })}
                    >
                        <Icon name="arrow-up" size={16} color={theme.colors.text.secondary} />
                    </Pressable>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('sessionsList.reminders.movePresetDownLabel', { preset: effectivePresetLabel })}
                        disabled={saving || index === drafts.length - 1}
                        onPress={() => setDrafts((current) => moveItem(current, index, index + 1))}
                        style={({ pressed }) => ({ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', opacity: index === drafts.length - 1 ? 0.28 : pressed ? motionTokens.press.opacity : 1 })}
                    >
                        <Icon name="arrow-down" size={16} color={theme.colors.text.secondary} />
                    </Pressable>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('sessionsList.reminders.deletePresetLabel', { preset: effectivePresetLabel })}
                        disabled={saving}
                        onPress={() => setDrafts((current) => current.filter((_, presetIndex) => presetIndex !== index))}
                        style={({ pressed }) => ({ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', opacity: pressed ? motionTokens.press.opacity : 1 })}
                    >
                        <Icon name="trash" size={16} color={theme.colors.state.danger.foreground} />
                    </Pressable>
                </View>
                );
            })}
            {error ? <Text testID="session-reminder-presets-error" accessibilityLiveRegion="polite" style={{ color: theme.colors.text.primary }}>{error}</Text> : null}
            {drafts.length === 0 ? (
                <View style={{ paddingVertical: 30, alignItems: 'center', gap: 7 }}>
                    <Text style={{ ...Typography.default('semiBold'), color: theme.colors.text.primary }}>{t('sessionsList.reminders.noPresets')}</Text>
                    <Text style={{ color: theme.colors.text.secondary, textAlign: 'center' }}>{t('sessionsList.reminders.noPresetsMessage')}</Text>
                </View>
            ) : null}
        </ScrollView>
    );
}
