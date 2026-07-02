import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { TextInput } from '@/components/ui/text/Text';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/domains/state/storage';

export const SessionProviderLimitsSettingsView = React.memo(function SessionProviderLimitsSettingsView() {
    const { theme } = useUnistyles();
    const popoverBoundaryRef = React.useRef<any>(null);
    const usageLimitRecoveryEnabled = useFeatureEnabled('sessions.usageLimitRecovery');
    const connectedServiceQuotasEnabled = useFeatureEnabled('connectedServices.quotas');
    const [usageLimitRecoverySettings, setUsageLimitRecoverySettings] = useSettingMutable('usageLimitRecoverySettingsV1');
    const [sessionProviderUsageGaugeMode, setSessionProviderUsageGaugeMode] = useSettingMutable('sessionProviderUsageGaugeMode');
    const [sessionProviderUsageGaugeWindowMode, setSessionProviderUsageGaugeWindowMode] = useSettingMutable('sessionProviderUsageGaugeWindowMode');
    const [openUsageLimitRecoveryResumePromptMenu, setOpenUsageLimitRecoveryResumePromptMenu] = React.useState(false);
    const [openProviderUsageGaugeWindowMenu, setOpenProviderUsageGaugeWindowMenu] = React.useState(false);
    const usageLimitRecoveryMode = usageLimitRecoverySettings?.mode === 'auto_wait' ? 'auto_wait' : 'ask';
    const usageLimitRecoveryAutoWait = usageLimitRecoveryMode === 'auto_wait';
    const usageLimitRecoveryResumePromptMode =
        usageLimitRecoverySettings?.resumePromptMode === 'off' || usageLimitRecoverySettings?.resumePromptMode === 'custom'
            ? usageLimitRecoverySettings.resumePromptMode
            : 'standard';
    const usageLimitRecoveryCustomResumePrompt = usageLimitRecoverySettings?.customResumePrompt ?? '';
    const [customResumePromptDraft, setCustomResumePromptDraft] = React.useState(usageLimitRecoveryCustomResumePrompt);
    const customResumePromptDraftRef = React.useRef(customResumePromptDraft);
    const updateCustomResumePromptDraft = React.useCallback((text: string) => {
        customResumePromptDraftRef.current = text;
        setCustomResumePromptDraft(text);
    }, []);
    React.useEffect(() => {
        customResumePromptDraftRef.current = usageLimitRecoveryCustomResumePrompt;
        setCustomResumePromptDraft(usageLimitRecoveryCustomResumePrompt);
    }, [usageLimitRecoveryCustomResumePrompt]);
    const writeUsageLimitRecoverySettings = React.useCallback((next: Readonly<{
        mode: 'ask' | 'auto_wait';
        resumePromptMode: 'standard' | 'off' | 'custom';
        customResumePrompt: string;
    }>) => {
        const customResumePrompt = next.customResumePrompt.trim().slice(0, 2000);
        setUsageLimitRecoverySettings({
            v: 1,
            mode: next.mode,
            promptMode: 'standard',
            resumePromptMode: next.resumePromptMode,
            ...(customResumePrompt.length > 0 ? { customResumePrompt } : {}),
        });
    }, [setUsageLimitRecoverySettings]);
    const commitCustomResumePromptDraft = React.useCallback((draft: string) => {
        writeUsageLimitRecoverySettings({
            mode: usageLimitRecoveryMode,
            resumePromptMode: usageLimitRecoveryResumePromptMode,
            customResumePrompt: draft,
        });
    }, [writeUsageLimitRecoverySettings, usageLimitRecoveryMode, usageLimitRecoveryResumePromptMode]);
    const providerUsageGaugeVisible = sessionProviderUsageGaugeMode !== 'hidden';
    const providerUsageGaugeWindowMode =
        sessionProviderUsageGaugeWindowMode === 'daily'
        || sessionProviderUsageGaugeWindowMode === 'weekly'
        || sessionProviderUsageGaugeWindowMode === 'session'
        || sessionProviderUsageGaugeWindowMode === 'primary'
        || sessionProviderUsageGaugeWindowMode === 'secondary'
            ? sessionProviderUsageGaugeWindowMode
            : 'most_constrained';
    const providerUsageGaugeWindowOptions = [
        { id: 'most_constrained', title: t('settingsSession.providerUsageGauge.windowMostConstrainedTitle'), subtitle: t('settingsSession.providerUsageGauge.windowMostConstrainedSubtitle') },
        { id: 'daily', title: t('settingsSession.providerUsageGauge.windowDailyTitle'), subtitle: t('settingsSession.providerUsageGauge.windowDailySubtitle') },
        { id: 'weekly', title: t('settingsSession.providerUsageGauge.windowWeeklyTitle'), subtitle: t('settingsSession.providerUsageGauge.windowWeeklySubtitle') },
        { id: 'session', title: t('settingsSession.providerUsageGauge.windowSessionTitle'), subtitle: t('settingsSession.providerUsageGauge.windowSessionSubtitle') },
        { id: 'primary', title: t('settingsSession.providerUsageGauge.windowPrimaryTitle'), subtitle: t('settingsSession.providerUsageGauge.windowPrimarySubtitle') },
        { id: 'secondary', title: t('settingsSession.providerUsageGauge.windowSecondaryTitle'), subtitle: t('settingsSession.providerUsageGauge.windowSecondarySubtitle') },
    ] as const;
    const resumePromptOptions = [
        { id: 'standard', title: t('settingsSession.usageLimitRecovery.resumePromptStandardTitle'), subtitle: t('settingsSession.usageLimitRecovery.resumePromptStandardSubtitle') },
        { id: 'custom', title: t('settingsSession.usageLimitRecovery.resumePromptCustomTitle'), subtitle: t('settingsSession.usageLimitRecovery.resumePromptCustomSubtitle') },
        { id: 'off', title: t('settingsSession.usageLimitRecovery.resumePromptOffTitle'), subtitle: t('settingsSession.usageLimitRecovery.resumePromptOffSubtitle') },
    ] as const;

    return (
        <ItemList ref={popoverBoundaryRef} style={{ paddingTop: 0 }}>
            {usageLimitRecoveryEnabled ? (
                <ItemGroup title={t('settingsSession.usageLimitRecovery.title')}>
                    <Item
                        testID="settings-session-usage-limit-recovery"
                        title={t('settingsSession.usageLimitRecovery.autoWaitTitle')}
                        subtitle={t(usageLimitRecoveryAutoWait
                            ? 'settingsSession.usageLimitRecovery.autoWaitEnabledSubtitle'
                            : 'settingsSession.usageLimitRecovery.autoWaitDisabledSubtitle')}
                        icon={<Ionicons name="time-outline" size={29} color={theme.colors.accent.blue} />}
                        rightElement={<Switch value={usageLimitRecoveryAutoWait} onValueChange={(next) => writeUsageLimitRecoverySettings({ mode: next ? 'auto_wait' : 'ask', resumePromptMode: usageLimitRecoveryResumePromptMode, customResumePrompt: usageLimitRecoveryCustomResumePrompt })} />}
                        showChevron={false}
                        onPress={() => writeUsageLimitRecoverySettings({ mode: usageLimitRecoveryAutoWait ? 'ask' : 'auto_wait', resumePromptMode: usageLimitRecoveryResumePromptMode, customResumePrompt: usageLimitRecoveryCustomResumePrompt })}
                    />
                    <DropdownMenu
                        open={openUsageLimitRecoveryResumePromptMenu}
                        onOpenChange={setOpenUsageLimitRecoveryResumePromptMenu}
                        variant="selectable"
                        search={false}
                        selectedId={usageLimitRecoveryResumePromptMode}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        popoverBoundaryRef={popoverBoundaryRef}
                        itemTrigger={{
                            title: t('settingsSession.usageLimitRecovery.resumePromptTitle'),
                            subtitle: resumePromptOptions.find((option) => option.id === usageLimitRecoveryResumePromptMode)?.title,
                            icon: <Ionicons name="chatbubble-ellipses-outline" size={29} color={theme.colors.accent.blue} />,
                            showSelectedSubtitle: false,
                            itemProps: { testID: 'settings-session-usage-limit-recovery-resume-prompt' },
                        }}
                        items={resumePromptOptions}
                        onSelect={(id) => {
                            if (id !== 'standard' && id !== 'off' && id !== 'custom') return;
                            writeUsageLimitRecoverySettings({ mode: usageLimitRecoveryMode, resumePromptMode: id, customResumePrompt: usageLimitRecoveryCustomResumePrompt });
                            setOpenUsageLimitRecoveryResumePromptMenu(false);
                        }}
                    />
                    {usageLimitRecoveryResumePromptMode === 'custom' ? (
                        <Item
                            testID="settings-session-usageLimitRecovery-customResumePrompt"
                            title={t('settingsSession.usageLimitRecovery.customResumePromptTitle')}
                            subtitle={(
                                <TextInput
                                    testID="settings-session-usageLimitRecovery-customResumePrompt-input"
                                    value={customResumePromptDraft}
                                    onChangeText={updateCustomResumePromptDraft}
                                    onBlur={() => commitCustomResumePromptDraft(customResumePromptDraftRef.current)}
                                    onSubmitEditing={() => commitCustomResumePromptDraft(customResumePromptDraftRef.current)}
                                    placeholder={t('settingsSession.usageLimitRecovery.customResumePromptPlaceholder')}
                                    placeholderTextColor={theme.colors.input.placeholder}
                                    maxLength={2000}
                                    style={{ color: theme.colors.input.text }}
                                />
                            )}
                            subtitleLines={0}
                            icon={<Ionicons name="create-outline" size={29} color={theme.colors.accent.blue} />}
                            mode="info"
                            showChevron={false}
                        />
                    ) : null}
                </ItemGroup>
            ) : null}
            {connectedServiceQuotasEnabled ? (
                <ItemGroup title={t('settingsSession.providerUsageGauge.title')} footer={t('settingsSession.providerUsageGauge.footer')}>
                    <Item
                        testID="settings-session-providerUsageGauge-visibility"
                        title={t('settingsSession.providerUsageGauge.visibilityTitle')}
                        subtitle={providerUsageGaugeVisible ? t('settingsSession.providerUsageGauge.visibilityEnabledSubtitle') : t('settingsSession.providerUsageGauge.visibilityHiddenSubtitle')}
                        icon={<Ionicons name="speedometer-outline" size={29} color={theme.colors.accent.indigo} />}
                        rightElement={<Switch testID="settings-session-providerUsageGauge-visibility-toggle" value={providerUsageGaugeVisible} onValueChange={(next) => setSessionProviderUsageGaugeMode(next ? 'auto' : 'hidden')} />}
                        showChevron={false}
                        onPress={() => setSessionProviderUsageGaugeMode(providerUsageGaugeVisible ? 'hidden' : 'auto')}
                    />
                    <DropdownMenu
                        open={openProviderUsageGaugeWindowMenu}
                        onOpenChange={setOpenProviderUsageGaugeWindowMenu}
                        variant="selectable"
                        search={false}
                        selectedId={providerUsageGaugeWindowMode}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        popoverBoundaryRef={popoverBoundaryRef}
                        itemTrigger={{
                            title: t('settingsSession.providerUsageGauge.windowTitle'),
                            subtitle: providerUsageGaugeWindowOptions.find((option) => option.id === providerUsageGaugeWindowMode)?.title,
                            icon: <Ionicons name="analytics-outline" size={29} color={theme.colors.accent.blue} />,
                            showSelectedSubtitle: false,
                            itemProps: { testID: 'settings-session-providerUsageGauge-window-trigger' },
                        }}
                        items={providerUsageGaugeWindowOptions}
                        onSelect={(id) => {
                            if (!providerUsageGaugeWindowOptions.some((option) => option.id === id)) return;
                            setSessionProviderUsageGaugeWindowMode(id as typeof providerUsageGaugeWindowOptions[number]['id']);
                            setOpenProviderUsageGaugeWindowMenu(false);
                        }}
                    />
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});

export default SessionProviderLimitsSettingsView;
