import { ProviderUsageGaugeSettingsGroup } from '@/components/settings/connectedServices/ProviderUsageGaugeSettingsGroup';
import * as React from 'react';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import { SESSION_PROVIDER_LIMITS_SETTINGS } from '@/components/settings/session/sessionProviderLimitsSettings';

export const SessionProviderLimitsSettingsView = React.memo(function SessionProviderLimitsSettingsView() {
    const popoverBoundaryRef = React.useRef<any>(null);
    const usageLimitRecoveryEnabled = useFeatureEnabled('sessions.usageLimitRecovery');
    const connectedServiceQuotasEnabled = useFeatureEnabled('connectedServices.quotas');
    const [usageLimitRecoverySettings, setUsageLimitRecoverySettings] = useSettingMutable('usageLimitRecoverySettingsV1');
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

    return (
        <ItemList ref={popoverBoundaryRef} style={{ paddingTop: 0 }}>
            <SettingsPageHeader description={t('settingsSessionPages.providerLimits.pageDescription')} />
            {usageLimitRecoveryEnabled ? (
                <ItemGroup
                    title={t('settingsSession.usageLimitRecovery.title')}
                    description={t('settingsSessionPages.providerLimits.recoveryDescription')}
                >
                    <SettingRow
                        setting={SESSION_PROVIDER_LIMITS_SETTINGS.settings.autoWait}
                        testID="settings-session-usage-limit-recovery"
                        subtitle={t(usageLimitRecoveryAutoWait
                            ? 'settingsSession.usageLimitRecovery.autoWaitEnabledSubtitle'
                            : 'settingsSession.usageLimitRecovery.autoWaitDisabledSubtitle')}
                        rightElement={<Switch value={usageLimitRecoveryAutoWait} onValueChange={(next) => writeUsageLimitRecoverySettings({ mode: next ? 'auto_wait' : 'ask', resumePromptMode: usageLimitRecoveryResumePromptMode, customResumePrompt: usageLimitRecoveryCustomResumePrompt })} />}
                        showChevron={false}
                        onPress={() => writeUsageLimitRecoverySettings({ mode: usageLimitRecoveryAutoWait ? 'ask' : 'auto_wait', resumePromptMode: usageLimitRecoveryResumePromptMode, customResumePrompt: usageLimitRecoveryCustomResumePrompt })}
                    />
                    <SettingAnchor setting={SESSION_PROVIDER_LIMITS_SETTINGS.settings.resumePrompt}>
                        <SegmentedChoiceItem<'standard' | 'custom' | 'off'>
                            subtitleLines={0}
                            testID="settings-session-usage-limit-recovery-resume-prompt"
                            testIDPrefix="settings-session-usage-limit-recovery-resume-prompt"
                            title={t(SESSION_PROVIDER_LIMITS_SETTINGS.settings.resumePrompt.titleKey)}
                            options={[
                                { id: 'standard', label: t('settingsSession.usageLimitRecovery.resumePromptStandardTitle'), description: t('settingsSession.usageLimitRecovery.resumePromptStandardSubtitle') },
                                { id: 'custom', label: t('settingsSessionPages.providerLimits.resumePromptCustom'), description: t('settingsSession.usageLimitRecovery.resumePromptCustomSubtitle') },
                                { id: 'off', label: t('settingsSession.usageLimitRecovery.resumePromptOffTitle'), description: t('settingsSession.usageLimitRecovery.resumePromptOffSubtitle') },
                            ]}
                            value={usageLimitRecoveryResumePromptMode}
                            onChange={(id) => writeUsageLimitRecoverySettings({ mode: usageLimitRecoveryMode, resumePromptMode: id, customResumePrompt: usageLimitRecoveryCustomResumePrompt })}
                        />
                    </SettingAnchor>
                    {usageLimitRecoveryResumePromptMode === 'custom' ? (
                        <Item
                            testID="settings-session-usageLimitRecovery-customResumePrompt"
                            title={t('settingsSession.usageLimitRecovery.customResumePromptTitle')}
                            accessoryLayout="stacked"
                            showChevron={false}
                            rightElement={(
                                <FieldTextInput
                                    testID="settings-session-usageLimitRecovery-customResumePrompt-input"
                                    accessibilityLabel={t('settingsSession.usageLimitRecovery.customResumePromptTitle')}
                                    value={customResumePromptDraft}
                                    onChangeText={updateCustomResumePromptDraft}
                                    onBlur={() => commitCustomResumePromptDraft(customResumePromptDraftRef.current)}
                                    onSubmitEditing={() => commitCustomResumePromptDraft(customResumePromptDraftRef.current)}
                                    placeholder={t('settingsSession.usageLimitRecovery.customResumePromptPlaceholder')}
                                    autoCapitalize="sentences"
                                    maxLength={2000}
                                    multiline
                                    minLines={2}
                                />
                            )}
                        />
                    ) : null}
                </ItemGroup>
            ) : null}
            <ProviderUsageGaugeSettingsGroup />
            {!usageLimitRecoveryEnabled && !connectedServiceQuotasEnabled ? (
                <ItemGroup>
                    <Item
                        testID="settings-session-provider-limits-unavailable"
                        title={t('settingsSessionPages.providerLimits.unavailableTitle')}
                        subtitle={t('settingsSessionPages.providerLimits.unavailableDescription')}
                        subtitleLines={0}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});

export default SessionProviderLimitsSettingsView;
