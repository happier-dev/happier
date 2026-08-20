import * as React from 'react';
import { useRouter } from 'expo-router';
import { HAPPIER_REPLAY_SEED_MAX_CHARS, HAPPIER_REPLAY_SEED_MIN_CHARS } from '@happier-dev/protocol';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text, TextInput } from '@/components/ui/text/Text';
import { LlmTaskRunnerConfigV1BackendModelPicker } from '@/components/settings/llmTasks/LlmTaskRunnerConfigV1BackendModelPicker';
import { Typography } from '@/constants/Typography';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { Icon } from '@/components/ui/icons/Icon';

/**
 * Bounds come from the one Replay-budget owner in the Protocol. Below the floor
 * the seed builder correctly produces nothing, so a screen that let a smaller
 * number be typed was offering a setting that silently turned Replay off.
 */
const SESSION_REPLAY_MAX_SEED_CHARS_MIN = HAPPIER_REPLAY_SEED_MIN_CHARS;
const SESSION_REPLAY_MAX_SEED_CHARS_MAX = HAPPIER_REPLAY_SEED_MAX_CHARS;

function sanitizeNumericInput(value: string): string {
    return String(value).replace(/[^0-9]/g, '');
}

function formatIntegerSettingValue(value: unknown): string {
    return typeof value === 'number' && Number.isFinite(value) ? String(Math.trunc(value)) : '';
}

function clampInteger(value: number, bounds: Readonly<{ min: number; max: number }>): number {
    return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(value)));
}

export const SessionResumeSettingsView = React.memo(function SessionResumeSettingsView() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const popoverBoundaryRef = React.useRef<any>(null);
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const [sessionReplayEnabled, setSessionReplayEnabled] = useSettingMutable('sessionReplayEnabled');
    const [sessionReplayStrategy, setSessionReplayStrategy] = useSettingMutable('sessionReplayStrategy');
    const [sessionReplayMaxSeedChars, setSessionReplayMaxSeedChars] = useSettingMutable('sessionReplayMaxSeedChars');
    const [sessionReplaySummaryRunnerV1, setSessionReplaySummaryRunnerV1] = useSettingMutable('sessionReplaySummaryRunnerV1');
    const [openReplayMenu, setOpenReplayMenu] = React.useState(false);
    const [sessionReplayMaxSeedCharsDraft, setSessionReplayMaxSeedCharsDraft] = React.useState(() =>
        formatIntegerSettingValue(sessionReplayMaxSeedChars),
    );
    /**
     * "Summary + recent" only reaches the daemon as a summary when a runner is
     * forwarded, and the fork resolver forwards one only when execution runs
     * are on AND a runner is set. Either gap silently degrades the strategy to
     * recent-only, so the screen states the unmet requirement instead of
     * letting the user discover it from a fork that looks wrong.
     */
    const summaryRunnerRequirement: 'satisfied' | 'needs_execution_runs' | 'needs_model' =
        !executionRunsEnabled
            ? 'needs_execution_runs'
            : sessionReplaySummaryRunnerV1 ? 'satisfied' : 'needs_model';
    const summaryRunnerRequirementNotice = summaryRunnerRequirement === 'needs_execution_runs'
        ? t('settingsSession.replayResume.summaryRunner.requiresExecutionRunsNotice')
        : summaryRunnerRequirement === 'needs_model'
            ? t('settingsSession.replayResume.summaryRunner.requiresModelNotice')
            : null;
    const replayStrategyOptions = [
        { key: 'recent_messages', title: t('settingsSession.replayResume.strategy.recentTitle'), subtitle: t('settingsSession.replayResume.strategy.recentSubtitle') },
        {
            key: 'summary_plus_recent',
            title: t('settingsSession.replayResume.strategy.summaryRecentTitle'),
            // Execution runs off is the one gap the user cannot close from this
            // screen, so it is disclosed before the choice rather than after.
            subtitle: summaryRunnerRequirement === 'needs_execution_runs'
                ? `${t('settingsSession.replayResume.strategy.summaryRecentSubtitle')} ${t('settingsSession.replayResume.summaryRunner.requiresExecutionRunsNotice')}`
                : t('settingsSession.replayResume.strategy.summaryRecentSubtitle'),
        },
    ] as const;
    const maxSeedCharsRangeNotice = t('settingsSession.replayResume.maxSeedCharsRange', {
        min: SESSION_REPLAY_MAX_SEED_CHARS_MIN,
        max: SESSION_REPLAY_MAX_SEED_CHARS_MAX,
    });
    const commitSessionReplayMaxSeedCharsDraft = React.useCallback(() => {
        const sanitized = sanitizeNumericInput(sessionReplayMaxSeedCharsDraft);
        if (sanitized.length === 0) {
            setSessionReplayMaxSeedCharsDraft(formatIntegerSettingValue(sessionReplayMaxSeedChars));
            return;
        }
        const next = Number(sanitized);
        if (!Number.isFinite(next)) {
            setSessionReplayMaxSeedCharsDraft(formatIntegerSettingValue(sessionReplayMaxSeedChars));
            return;
        }
        const clamped = clampInteger(next, {
            min: SESSION_REPLAY_MAX_SEED_CHARS_MIN,
            max: SESSION_REPLAY_MAX_SEED_CHARS_MAX,
        });
        setSessionReplayMaxSeedChars(clamped as any);
        setSessionReplayMaxSeedCharsDraft(String(clamped));
    }, [sessionReplayMaxSeedChars, sessionReplayMaxSeedCharsDraft, setSessionReplayMaxSeedChars]);

    React.useEffect(() => {
        const normalized = formatIntegerSettingValue(sessionReplayMaxSeedChars);
        setSessionReplayMaxSeedCharsDraft((current) => current === normalized ? current : normalized);
    }, [sessionReplayMaxSeedChars]);

    return (
        <ItemList ref={popoverBoundaryRef} style={{ paddingTop: 0 }}>
            <ItemGroup title={t('settingsSession.replayResume.title')} footer={t('settingsSession.replayResume.footer')}>
                <Item
                    testID="settings-session-replay-enabled-item"
                    title={t('settingsSession.replayResume.enabledTitle')}
                    subtitle={sessionReplayEnabled ? t('settingsSession.replayResume.enabledSubtitleOn') : t('settingsSession.replayResume.enabledSubtitleOff')}
                    icon={<Icon name="arrow-clockwise" size={29} color={theme.colors.state.success.foreground} />}
                    rightElement={<Switch value={sessionReplayEnabled} onValueChange={setSessionReplayEnabled} />}
                    showChevron={false}
                    onPress={() => setSessionReplayEnabled(!sessionReplayEnabled)}
                />
                {sessionReplayEnabled ? (
                    <>
                        <DropdownMenu
                            open={openReplayMenu}
                            onOpenChange={setOpenReplayMenu}
                            variant="selectable"
                            search={false}
                            selectedId={String(sessionReplayStrategy ?? 'recent_messages')}
                            showCategoryTitles={false}
                            matchTriggerWidth={true}
                            connectToTrigger={true}
                            rowKind="item"
                            popoverBoundaryRef={popoverBoundaryRef}
                            itemTrigger={{
                                title: t('settingsSession.replayResume.strategyTitle'),
                                icon: <Icon name="list" size={29} color={theme.colors.state.success.foreground} />,
                            }}
                            items={replayStrategyOptions.map((opt) => ({
                                id: opt.key,
                                title: opt.title,
                                subtitle: opt.subtitle,
                            }))}
                            onSelect={(id) => {
                                setSessionReplayStrategy(id as any);
                                setOpenReplayMenu(false);
                            }}
                        />
                        {summaryRunnerRequirementNotice && sessionReplayStrategy === 'summary_plus_recent' ? (
                            <View style={[styles.inputContainer, { paddingTop: 0 }]}>
                                <Text
                                    testID="settings-session-replay-summaryRunner-requirement"
                                    style={styles.fieldNotice}
                                >
                                    {summaryRunnerRequirementNotice}
                                </Text>
                            </View>
                        ) : null}
                        <View style={[styles.inputContainer, { paddingTop: 0 }]}>
                            <Text style={styles.fieldLabel}>{t('settingsSession.replayResume.maxSeedCharsTitle')}</Text>
                            <TextInput
                                testID="settings-session-replay-maxSeedChars-input"
                                style={styles.textInput}
                                placeholder={t('settingsSession.replayResume.maxSeedCharsPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                value={sessionReplayMaxSeedCharsDraft}
                                keyboardType={Platform.select({ ios: 'number-pad', default: 'numeric' }) as any}
                                // The visible label is not attached to the field, and the
                                // commit below moves an out-of-range number to the nearest
                                // limit. A field that adjusts what was typed has to say so
                                // and name its bounds first, or the adjustment reads as the
                                // setting being ignored.
                                accessibilityLabel={t('settingsSession.replayResume.maxSeedCharsTitle')}
                                accessibilityHint={maxSeedCharsRangeNotice}
                                onChangeText={(value) => setSessionReplayMaxSeedCharsDraft(sanitizeNumericInput(value))}
                                onBlur={commitSessionReplayMaxSeedCharsDraft}
                                onEndEditing={commitSessionReplayMaxSeedCharsDraft}
                            />
                            <Text
                                testID="settings-session-replay-maxSeedChars-range"
                                style={styles.fieldNotice}
                            >
                                {maxSeedCharsRangeNotice}
                            </Text>
                        </View>
                        {executionRunsEnabled && sessionReplayStrategy === 'summary_plus_recent' ? (
                            <View style={[styles.inputContainer, { paddingTop: 0 }]}>
                                <Text style={styles.fieldLabel}>{t('settingsSession.replayResume.summaryRunner.title')}</Text>
                                <LlmTaskRunnerConfigV1BackendModelPicker
                                    value={(sessionReplaySummaryRunnerV1 as any) ?? null}
                                    onChange={(next) => setSessionReplaySummaryRunnerV1((next as any) ?? null)}
                                    backendTestID="settings-session-replay-summaryRunner-backend"
                                    modelTestID="settings-session-replay-summaryRunner-model"
                                    popoverBoundaryRef={popoverBoundaryRef}
                                />
                            </View>
                        ) : null}
                    </>
                ) : null}
            </ItemGroup>

            <ItemGroup title={t('settingsSession.handoff.groupTitle')} footer={t('settingsSession.handoff.groupFooter')}>
                <Item
                    title={t('settingsSession.handoff.title')}
                    subtitle={t('settingsSession.handoff.entrySubtitle')}
                    icon={<Icon name="arrows-left-right" size={29} color={theme.colors.accent.green} />}
                    onPress={() => router.push('/settings/session/handoff')}
                />
            </ItemGroup>
        </ItemList>
    );
});

const styles = StyleSheet.create((theme) => ({
    inputContainer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    fieldLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text.secondary,
        marginBottom: 4,
    },
    fieldNotice: {
        ...Typography.default('regular'),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.state.warning.foreground,
    },
    textInput: {
        ...Typography.default('regular'),
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ ios: 10, default: 12 }),
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 24 }),
        color: theme.colors.input.text,
    },
}));

export default SessionResumeSettingsView;
