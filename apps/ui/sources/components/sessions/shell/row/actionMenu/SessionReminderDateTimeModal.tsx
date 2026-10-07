import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import {
    LocalDateTimeEditor,
    resolveFutureLocalDateTime,
} from '@/components/ui/dateTime/LocalDateTimeEditor';
import { toLocalDateTimeDraft, type LocalDateTimeDraft } from '@/components/ui/dateTime/localDateTimeValue';
import type { CustomModalInjectedProps } from '@/modal/types';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import {
    formatSessionReminderPresetRuleLabel,
    inferSessionReminderPresetRule,
    resolveSessionReminderPresetRule,
    type SessionReminderPresetV1,
} from '@/sync/domains/session/organization/sessionReminderPreset';
import { t } from '@/text';

export type SessionReminderDateTimeResult = Readonly<{
    remindAt: number;
    preset?: SessionReminderPresetV1;
}>;

export type SessionReminderDateTimeSubmitResult = Readonly<{ success: boolean; message?: string }>;

export function SessionReminderDateTimeModal(props: Readonly<{
    nowMs: number;
    /**
     * The one canonical save. It runs while this modal is still mounted so a failure keeps the
     * chosen date, time and Add-to-presets switch and can be retried, instead of discarding the
     * draft into an alert.
     */
    onSubmit: (value: SessionReminderDateTimeResult) => Promise<SessionReminderDateTimeSubmitResult>;
    onSavePreset: (preset: SessionReminderPresetV1) => Promise<void>;
    onResolve: (value: SessionReminderDateTimeResult | null) => void;
}> & CustomModalInjectedProps) {
    const { theme } = useUnistyles();
    const initial = React.useMemo(() => new Date(resolveSessionReminderPresetRule({
        kind: 'relative_day',
        daysAhead: 1,
        minuteOfDay: 9 * 60,
    }, props.nowMs)), [props.nowMs]);
    const [draft, setDraft] = React.useState<LocalDateTimeDraft>(() => toLocalDateTimeDraft(initial));
    const [savePreset, setSavePreset] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [savedReminder, setSavedReminder] = React.useState<SessionReminderDateTimeResult | null>(null);
    // `props.nowMs` is the instant the menu action opened this modal. A submit re-reads the clock,
    // so a chosen time that expired while the modal was open is refused and explained here instead
    // of being scheduled as an already-due reminder.
    const [observedNowMs, setObservedNowMs] = React.useState(props.nowMs);
    const nowMs = Math.max(props.nowMs, observedNowMs);
    const validTimestamp = resolveFutureLocalDateTime(draft, nowMs);
    const rule = validTimestamp === null ? null : inferSessionReminderPresetRule(validTimestamp, nowMs);

    const finish = React.useCallback((value: SessionReminderDateTimeResult | null) => {
        props.onResolve(value);
        props.onClose();
    }, [props]);

    const footer = React.useMemo(() => (
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10 }}>
            <RoundButton display="inverted" title={savedReminder ? t('common.close') : t('common.cancel')} disabled={saving} onPress={() => finish(savedReminder)} />
            <RoundButton
                title={savedReminder ? t('common.retry') : t('sessionsList.reminders.setReminder')}
                disabled={(!savedReminder && validTimestamp === null) || saving}
                loading={saving}
                onPress={() => {
                    if (saving) return;
                    const submittedAtMs = Date.now();
                    const submitted = savedReminder?.remindAt ?? resolveFutureLocalDateTime(draft, submittedAtMs);
                    if (submitted === null) {
                        setObservedNowMs(submittedAtMs);
                        setError(null);
                        return;
                    }
                    const submittedRule = savePreset ? inferSessionReminderPresetRule(submitted, submittedAtMs) : null;
                    const value: SessionReminderDateTimeResult = savedReminder ?? {
                        remindAt: submitted,
                        ...(submittedRule ? { preset: { rule: submittedRule } } : {}),
                    };
                    setSaving(true);
                    setError(null);
                    void (async () => {
                        let reminderIsSaved = savedReminder !== null;
                        try {
                            if (!reminderIsSaved) {
                                const result = await props.onSubmit(value);
                                if (!result.success) {
                                    setError(result.message ?? t('errors.unknownError'));
                                    return;
                                }
                                reminderIsSaved = true;
                                setSavedReminder(value);
                            }
                            if (value.preset) await props.onSavePreset(value.preset);
                            finish(value);
                        } catch {
                            setError(reminderIsSaved
                                ? t('sessionsList.reminders.presetSaveFailedAfterReminder')
                                : t('errors.unknownError'));
                        } finally {
                            setSaving(false);
                        }
                    })();
                }}
            />
        </View>
    ), [draft, finish, props, savedReminder, saving, savePreset, validTimestamp]);

    useModalCardChrome(props.setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        title: t('sessionsList.reminders.customTitle'),
        testID: 'session-reminder-date-time-modal',
        dimensions: { width: 480, maxHeightRatio: 0.86, size: 'md' as const },
        footer,
    }), [footer]));

    return (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 18, gap: 16 }}>
            {savedReminder ? <Item
                title={t('sessionsList.reminders.reminderSaved')}
                subtitle={new Date(savedReminder.remindAt).toLocaleString()}
                mode="info"
                showChevron={false}
                showDivider={false}
            /> : <>
            <LocalDateTimeEditor
                nowMs={nowMs}
                value={draft}
                onChange={setDraft}
                testIDPrefix="session-reminder"
                labels={{
                    date: t('sessionsList.reminders.dateLabel'),
                    time: t('sessionsList.reminders.timeLabel'),
                    pastInstant: t('sessionsList.reminders.futureTimeRequired'),
                }}
            />

            <View style={{ borderRadius: 14, borderWidth: 1, borderColor: theme.colors.border.default, overflow: 'hidden' }}>
                <Item
                    title={t('sessionsList.reminders.addToPresets')}
                    subtitle={savePreset
                        ? (rule ? formatSessionReminderPresetRuleLabel(rule, nowMs) : t('sessionsList.reminders.presetPreviewUnavailable'))
                        : undefined}
                    rightElement={(
                        <Switch
                            value={savePreset}
                            onValueChange={setSavePreset}
                            accessibilityRole="switch"
                            accessibilityLabel={t('sessionsList.reminders.addToPresets')}
                            accessibilityState={{ checked: savePreset }}
                        />
                    )}
                    rightElementOutsidePressable
                    showChevron={false}
                    showDivider={false}
                />
            </View>
            </>}

            {error ? <Item
                testID="session-reminder-error"
                title={error}
                titleLines={0}
                mode="info"
                accessibilityLiveRegion="polite"
                showChevron={false}
                showDivider={false}
            /> : null}
        </ScrollView>
    );
}
