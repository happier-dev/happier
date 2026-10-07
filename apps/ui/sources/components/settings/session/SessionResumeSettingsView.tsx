import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { HappierReplayWritableMaxSeedCharsSchema } from '@happier-dev/protocol/sessions/replay-seed-budget';
import { StyleSheet } from 'react-native-unistyles';
import { Icon } from '@/components/ui/icons/Icon';

import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { Switch } from '@/components/ui/forms/Switch';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { LlmTaskRunnerConfigV1BackendModelPicker } from '@/components/settings/llmTasks/LlmTaskRunnerConfigV1BackendModelPicker';
import { Typography } from '@/constants/Typography';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { SESSION_RESUME_SETTINGS } from '@/components/settings/session/sessionResumeSettings';

type ReplayStrategy = 'recent_messages' | 'summary_plus_recent';

function formatIntegerSettingValue(value: unknown): string {
    return typeof value === 'number' && Number.isFinite(value) ? String(Math.trunc(value)) : '';
}

export const SessionResumeSettingsView = React.memo(function SessionResumeSettingsView() {
    const router = useRouter();
    const popoverBoundaryRef = React.useRef<any>(null);
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const [sessionReplayEnabled, setSessionReplayEnabled] = useSettingMutable('sessionReplayEnabled');
    const [sessionReplayStrategy, setSessionReplayStrategy] = useSettingMutable('sessionReplayStrategy');
    const [sessionReplayMaxSeedChars, setSessionReplayMaxSeedChars] = useSettingMutable('sessionReplayMaxSeedChars');
    const [sessionReplaySummaryRunnerV1, setSessionReplaySummaryRunnerV1] = useSettingMutable('sessionReplaySummaryRunnerV1');
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
    const replayStrategyOptions: Array<{ id: ReplayStrategy; label: string; description: string }> = [
        { id: 'recent_messages', label: t('settingsSessionPages.resume.strategyRecent'), description: t('settingsSession.replayResume.strategy.recentSubtitle') },
        {
            id: 'summary_plus_recent',
            label: t('settingsSessionPages.resume.strategySummary'),
            // Execution runs off is the one gap the user cannot close from this
            // screen, so it is disclosed before the choice rather than after.
            description: summaryRunnerRequirement === 'needs_execution_runs'
                ? `${t('settingsSession.replayResume.strategy.summaryRecentSubtitle')} ${t('settingsSession.replayResume.summaryRunner.requiresExecutionRunsNotice')}`
                : t('settingsSession.replayResume.strategy.summaryRecentSubtitle'),
        },
    ];
    const maxSeedCharsDescription = t('settingsSession.replayResume.maxSeedCharsDescription');
    const commitSessionReplayMaxSeedChars = React.useCallback((draft: string) => {
        const parsed = HappierReplayWritableMaxSeedCharsSchema.safeParse(Number(draft));
        if (!parsed.success) return formatIntegerSettingValue(sessionReplayMaxSeedChars);
        if (parsed.data !== sessionReplayMaxSeedChars) setSessionReplayMaxSeedChars(parsed.data);
        return String(parsed.data);
    }, [sessionReplayMaxSeedChars, setSessionReplayMaxSeedChars]);

    return (
        <ItemList ref={popoverBoundaryRef} style={{ paddingTop: 0 }}>
            <SettingsPageHeader description={t('settingsSessionPages.resume.pageDescription')} />
            <SettingSection section={SESSION_RESUME_SETTINGS.sectionRefs.replay}>
                <ItemGroup title={t('settingsSession.replayResume.title')} description={t('settingsSession.replayResume.footer')}>
                    <SettingRow
                        setting={SESSION_RESUME_SETTINGS.settings.replayEnabled}
                        testID="settings-session-replay-enabled-item"
                        subtitle={sessionReplayEnabled ? t('settingsSession.replayResume.enabledSubtitleOn') : t('settingsSession.replayResume.enabledSubtitleOff')}
                        rightElement={<Switch value={sessionReplayEnabled} onValueChange={setSessionReplayEnabled} />}
                        showChevron={false}
                        onPress={() => setSessionReplayEnabled(!sessionReplayEnabled)}
                    />
                    {sessionReplayEnabled ? (
                        <SettingAnchor setting={SESSION_RESUME_SETTINGS.settings.replayStrategy}>
                            <SegmentedChoiceItem<ReplayStrategy>
                                testID="settings-session-replay-strategy"
                                testIDPrefix="settings-session-replay-strategy"
                                title={t(SESSION_RESUME_SETTINGS.settings.replayStrategy.titleKey)}
                                subtitleLines={0}
                                options={replayStrategyOptions}
                                value={sessionReplayStrategy === 'summary_plus_recent' ? 'summary_plus_recent' : 'recent_messages'}
                                onChange={setSessionReplayStrategy}
                            />
                        </SettingAnchor>
                    ) : null}
                    {sessionReplayEnabled && summaryRunnerRequirementNotice && sessionReplayStrategy === 'summary_plus_recent' ? (
                        <SectionContentRow testID="settings-session-replay-summaryRunner-requirement-row">
                            <Text testID="settings-session-replay-summaryRunner-requirement" style={styles.fieldNotice}>
                                {summaryRunnerRequirementNotice}
                            </Text>
                        </SectionContentRow>
                    ) : null}
                    {sessionReplayEnabled ? (
                        <SettingAnchor setting={SESSION_RESUME_SETTINGS.settings.maxSeedChars}>
                            <FieldValueItem
                                title={t(SESSION_RESUME_SETTINGS.settings.maxSeedChars.titleKey)}
                                subtitle={maxSeedCharsDescription}
                                subtitleLines={0}
                                kind="integer"
                                fieldTestID="settings-session-replay-maxSeedChars-input"
                                placeholder={t('settingsSession.replayResume.maxSeedCharsPlaceholder')}
                                value={formatIntegerSettingValue(sessionReplayMaxSeedChars)}
                                onCommit={commitSessionReplayMaxSeedChars}
                            />
                        </SettingAnchor>
                    ) : null}
                </ItemGroup>
            </SettingSection>
            {sessionReplayEnabled && executionRunsEnabled && sessionReplayStrategy === 'summary_plus_recent' ? (
                <SettingAnchor setting={SESSION_RESUME_SETTINGS.settings.summaryModel}>
                    <ItemGroup
                        title={t(SESSION_RESUME_SETTINGS.settings.summaryModel.titleKey)}
                        description={t('settingsSessionPages.resume.summaryModelDescription')}
                    >
                        <LlmTaskRunnerConfigV1BackendModelPicker
                            value={sessionReplaySummaryRunnerV1 ?? null}
                            onChange={(next) => setSessionReplaySummaryRunnerV1(next ?? null)}
                            backendTestID="settings-session-replay-summaryRunner-backend"
                            modelTestID="settings-session-replay-summaryRunner-model"
                            popoverBoundaryRef={popoverBoundaryRef}
                            showLabels={false}
                        />
                    </ItemGroup>
                </SettingAnchor>
            ) : null}
            <ItemGroup title={t('settingsSessionPages.resume.handoffSection')}>
                <SettingRow
                    icon={<Icon name="arrows-left-right" />}
                    setting={SESSION_RESUME_SETTINGS.settings.handoff}
                    onPress={() => router.push(SETTINGS_ROUTES.handoff)}
                />
            </ItemGroup>
        </ItemList>
    );
});

const styles = StyleSheet.create((theme) => ({
    fieldNotice: {
        ...Typography.default('regular'),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.state.warning.foreground,
    },
}));

export default SessionResumeSettingsView;
