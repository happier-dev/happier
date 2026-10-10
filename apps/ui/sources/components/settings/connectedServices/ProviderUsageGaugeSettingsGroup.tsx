import * as React from 'react';
import { MultiSelectField } from '@/components/ui/forms/dropdown/MultiSelectField';
import { Switch } from '@/components/ui/forms/Switch';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { SESSION_PROVIDER_LIMITS_SETTINGS } from '@/components/settings/session/sessionProviderLimitsSettings';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { isQuotaGaugeWindowMode, resolveQuotaGaugeWindowModes } from '@/sync/domains/connectedServices/quotaGaugeWindows';
import { t } from '@/text';

export const ProviderUsageGaugeSettingsGroup = React.memo(function ProviderUsageGaugeSettingsGroup(props: Readonly<{
    settings?: Readonly<{ gaugeVisible: SettingRef; gaugeWindow: SettingRef; gaugeLabels: SettingRef; routingHints: SettingRef }>;
}>) {
    const settings = props.settings ?? SESSION_PROVIDER_LIMITS_SETTINGS.settings;
    const enabled = useFeatureEnabled('connectedServices.quotas');
    const [visibility, setVisibility] = useSettingMutable('sessionProviderUsageGaugeMode');
    const [legacyWindow] = useSettingMutable('sessionProviderUsageGaugeWindowMode');
    const [windows, setWindows] = useSettingMutable('sessionProviderUsageGaugeWindowModes');
    const [labels, setLabels] = useSettingMutable('sessionUsageGaugeLabels');
    const [routingHints, setRoutingHints] = useSettingMutable('usageRoutingHintsEnabled');
    const selectedIds = resolveQuotaGaugeWindowModes(windows, legacyWindow);
    const visible = visibility !== 'hidden';
    const candidates = [
        { id: 'most_constrained', title: t('settingsSession.providerUsageGauge.windowMostConstrainedTitle'), subtitle: t('settingsSession.providerUsageGauge.windowMostConstrainedSubtitle') },
        { id: 'daily', title: t('settingsSession.providerUsageGauge.windowDailyTitle'), subtitle: t('settingsSession.providerUsageGauge.windowDailySubtitle') },
        { id: 'weekly', title: t('settingsSession.providerUsageGauge.windowWeeklyTitle'), subtitle: t('settingsSession.providerUsageGauge.windowWeeklySubtitle') },
        { id: 'session', title: t('settingsSession.providerUsageGauge.windowSessionTitle'), subtitle: t('settingsSession.providerUsageGauge.windowSessionSubtitle') },
        { id: 'primary', title: t('settingsSession.providerUsageGauge.windowPrimaryTitle'), subtitle: t('settingsSession.providerUsageGauge.windowPrimarySubtitle') },
        { id: 'secondary', title: t('settingsSession.providerUsageGauge.windowSecondaryTitle'), subtitle: t('settingsSession.providerUsageGauge.windowSecondarySubtitle') },
    ] as const;
    if (!enabled) return null;
    return <ItemGroup title={t('settingsSession.providerUsageGauge.title')} description={t('settingsSession.providerUsageGauge.footer')}>
        <SettingRow
            setting={settings.gaugeVisible}
            testID="settings-session-providerUsageGauge-visibility"
            subtitle={visible ? t('settingsSession.providerUsageGauge.visibilityEnabledSubtitle') : t('settingsSession.providerUsageGauge.visibilityHiddenSubtitle')}
            rightElement={<Switch testID="settings-session-providerUsageGauge-visibility-toggle" value={visible} onValueChange={(next) => setVisibility(next ? 'auto' : 'hidden')} />}
            showChevron={false}
            onPress={() => setVisibility(visible ? 'hidden' : 'auto')}
        />
        <SettingAnchor setting={settings.gaugeWindow}>
            <MultiSelectField
                testID="settings-session-providerUsageGauge-window-trigger"
                title={t(settings.gaugeWindow.titleKey)}
                candidates={candidates}
                selectedIds={selectedIds}
                onCommit={(ids) => setWindows(resolveQuotaGaugeWindowModes(ids.filter(isQuotaGaugeWindowMode)))}
                subtitle={() => candidates.filter((candidate) => selectedIds.includes(candidate.id)).map((candidate) => candidate.title).join(' + ')}
                emptySubtitle={t('common.unavailable')}
                searchPlaceholder={t('settingsSession.providerUsageGauge.windowTitle')}
                optionTestIDPrefix="settings-session-providerUsageGauge-window"
                minimumSelected={1}
                exclusiveId="most_constrained"
            />
        </SettingAnchor>
        <SettingRow
            setting={settings.gaugeLabels}
            testID="settings-session-providerUsageGauge-labels"
            subtitle={t('settingsSession.providerUsageGauge.labelsSubtitle')}
            rightElement={<Switch testID="settings-session-providerUsageGauge-labels-toggle" value={labels === true} onValueChange={setLabels} />}
            showChevron={false}
            onPress={() => setLabels(labels !== true)}
        />
        <SettingRow
            setting={settings.routingHints}
            testID="settings-session-providerUsageGauge-routingHints"
            subtitle={t('usage.board.plans.routingHintsSettingSubtitle')}
            rightElement={<Switch testID="settings-session-providerUsageGauge-routingHints-toggle" value={routingHints !== false} onValueChange={setRoutingHints} />}
            showChevron={false}
            onPress={() => setRoutingHints(routingHints === false)}
        />
    </ItemGroup>;
});
