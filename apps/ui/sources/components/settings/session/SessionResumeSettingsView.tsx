import * as React from 'react';
import { useRouter } from 'expo-router';
import { Platform, View, type KeyboardTypeOptions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text, TextInput } from '@/components/ui/text/Text';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { LlmTaskRunnerConfigV1BackendModelPicker } from '@/components/settings/llmTasks/LlmTaskRunnerConfigV1BackendModelPicker';
import { Typography } from '@/constants/Typography';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { Icon } from '@/components/ui/icons/Icon';

const SESSION_REPLAY_MAX_SEED_CHARS_MIN = 500;
const SESSION_REPLAY_MAX_SEED_CHARS_MAX = 200_000;
const numericKeyboardType = Platform.select<KeyboardTypeOptions>({ ios: 'number-pad', default: 'numeric' }) ?? 'numeric';

type ReplayStrategy = 'recent_messages' | 'summary_plus_recent';

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
    const [sessionReplayRecentMessagesCount, setSessionReplayRecentMessagesCount] = useSettingMutable('sessionReplayRecentMessagesCount');
    const [sessionReplayMaxSeedChars, setSessionReplayMaxSeedChars] = useSettingMutable('sessionReplayMaxSeedChars');
    const [sessionReplaySummaryRunnerV1, setSessionReplaySummaryRunnerV1] = useSettingMutable('sessionReplaySummaryRunnerV1');
    const [openReplayMenu, setOpenReplayMenu] = React.useState(false);
    const [sessionReplayMaxSeedCharsDraft, setSessionReplayMaxSeedCharsDraft] = React.useState(() =>
        formatIntegerSettingValue(sessionReplayMaxSeedChars),
    );
    const replayStrategyOptions: Array<{ key: ReplayStrategy; title: string; subtitle: string }> = [
        { key: 'recent_messages', title: t('settingsSession.replayResume.strategy.recentTitle'), subtitle: t('settingsSession.replayResume.strategy.recentSubtitle') },
        { key: 'summary_plus_recent', title: t('settingsSession.replayResume.strategy.summaryRecentTitle'), subtitle: t('settingsSession.replayResume.strategy.summaryRecentSubtitle') },
    ];
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
        setSessionReplayMaxSeedChars(clamped);
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
                                if (id === 'recent_messages' || id === 'summary_plus_recent') {
                                    setSessionReplayStrategy(id);
                                }
                                setOpenReplayMenu(false);
                            }}
                        />
                        <View style={[styles.inputContainer, { paddingTop: 0 }]}>
                            <Text style={styles.fieldLabel}>{t('settingsSession.replayResume.recentMessagesTitle')}</Text>
                            <TextInput
                                style={styles.textInput}
                                placeholder={t('settingsSession.replayResume.recentMessagesPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                value={String(sessionReplayRecentMessagesCount ?? '')}
                                keyboardType={numericKeyboardType}
                                onChangeText={(value) => {
                                    const next = Number(String(value).replace(/[^0-9]/g, ''));
                                    if (!Number.isFinite(next)) return;
                                    setSessionReplayRecentMessagesCount(Math.max(1, Math.min(500, Math.floor(next))));
                                }}
                            />
                        </View>
                        <View style={[styles.inputContainer, { paddingTop: 0 }]}>
                            <Text style={styles.fieldLabel}>{t('settingsSession.replayResume.maxSeedCharsTitle')}</Text>
                            <TextInput
                                testID="settings-session-replay-maxSeedChars-input"
                                style={styles.textInput}
                                placeholder={t('settingsSession.replayResume.maxSeedCharsPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                value={sessionReplayMaxSeedCharsDraft}
                                keyboardType={numericKeyboardType}
                                onChangeText={(value) => setSessionReplayMaxSeedCharsDraft(sanitizeNumericInput(value))}
                                onBlur={commitSessionReplayMaxSeedCharsDraft}
                                onEndEditing={commitSessionReplayMaxSeedCharsDraft}
                            />
                        </View>
                        {executionRunsEnabled && sessionReplayStrategy === 'summary_plus_recent' ? (
                            <View style={[styles.inputContainer, { paddingTop: 0 }]}>
                                <Text style={styles.fieldLabel}>{t('settingsSession.replayResume.summaryRunner.title')}</Text>
                                <LlmTaskRunnerConfigV1BackendModelPicker
                                    value={sessionReplaySummaryRunnerV1 ?? null}
                                    onChange={(next) => setSessionReplaySummaryRunnerV1(next ?? null)}
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
                    onPress={() => router.push(SETTINGS_ROUTES.handoff)}
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
