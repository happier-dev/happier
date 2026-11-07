import { UsageGaugeLabelsSettingsItem } from '@/components/settings/session/UsageGaugeLabelsSettingsItem';
import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { MultiSelectField } from '@/components/ui/forms/dropdown/MultiSelectField';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Icon } from '@/components/ui/icons/Icon';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { isAutomaticQuotaGaugeWindowSelection, isQuotaGaugeWindowMode, resolveQuotaGaugeWindowModes } from '@/sync/domains/connectedServices/quotaGaugeWindows';
import { t } from '@/text';

export const ProviderUsageGaugeSettingsGroup = React.memo(function ProviderUsageGaugeSettingsGroup() {
    const { theme } = useUnistyles();
    const enabled = useFeatureEnabled('connectedServices.quotas');
    const [visibility, setVisibility] = useSettingMutable('sessionProviderUsageGaugeMode');
    const [legacyWindow, setLegacyWindow] = useSettingMutable('sessionProviderUsageGaugeWindowMode');
    const [windows, setWindows] = useSettingMutable('sessionProviderUsageGaugeWindowModes');
    const selectedIds: readonly string[] = isAutomaticQuotaGaugeWindowSelection(windows, legacyWindow)
        ? ['automatic'] : resolveQuotaGaugeWindowModes(windows, legacyWindow);
    const visible = visibility !== 'hidden';
    const candidates = [
        { id: 'automatic', title: t('settingsSession.providerUsageGauge.windowAutomaticTitle'), subtitle: t('settingsSession.providerUsageGauge.windowAutomaticSubtitle') },
        { id: 'most_constrained', title: t('settingsSession.providerUsageGauge.windowMostConstrainedTitle'), subtitle: t('settingsSession.providerUsageGauge.windowMostConstrainedSubtitle') },
        { id: 'session', title: t('settingsSession.providerUsageGauge.windowSessionTitle'), subtitle: t('settingsSession.providerUsageGauge.windowSessionSubtitle') },
        { id: 'daily', title: t('settingsSession.providerUsageGauge.windowDailyTitle'), subtitle: t('settingsSession.providerUsageGauge.windowDailySubtitle') },
        { id: 'weekly', title: t('settingsSession.providerUsageGauge.windowWeeklyTitle'), subtitle: t('settingsSession.providerUsageGauge.windowWeeklySubtitle') },
        { id: 'primary', title: t('settingsSession.providerUsageGauge.windowPrimaryTitle'), subtitle: t('settingsSession.providerUsageGauge.windowPrimarySubtitle') },
        { id: 'secondary', title: t('settingsSession.providerUsageGauge.windowSecondaryTitle'), subtitle: t('settingsSession.providerUsageGauge.windowSecondarySubtitle') },
    ] as const;
    if (!enabled) return null;
    return <ItemGroup title={t('settingsSession.providerUsageGauge.title')} footer={t('settingsSession.providerUsageGauge.footer')}>
        <Item
            testID="settings-session-providerUsageGauge-visibility"
            title={t('settingsSession.providerUsageGauge.visibilityTitle')}
            subtitle={visible ? t('settingsSession.providerUsageGauge.visibilityEnabledSubtitle') : t('settingsSession.providerUsageGauge.visibilityHiddenSubtitle')}
            icon={<Icon name="speedometer" size={29} color={theme.colors.accent.indigo} />}
            rightElement={<Switch testID="settings-session-providerUsageGauge-visibility-toggle" value={visible} onValueChange={(next) => setVisibility(next ? 'auto' : 'hidden')} />}
            showChevron={false}
            onPress={() => setVisibility(visible ? 'hidden' : 'auto')}
        />
        <MultiSelectField
            testID="settings-session-providerUsageGauge-window-trigger"
            title={t('settingsSession.providerUsageGauge.windowTitle')}
            candidates={candidates}
            selectedIds={selectedIds}
            onCommit={(ids) => {
                if (ids.includes('automatic')) {
                    if (legacyWindow !== 'most_constrained') setLegacyWindow('most_constrained');
                    setWindows(null);
                } else setWindows(resolveQuotaGaugeWindowModes(ids.filter(isQuotaGaugeWindowMode)));
            }}
            subtitle={() => candidates.filter((candidate) => selectedIds.includes(candidate.id)).map((candidate) => candidate.title).join(' + ')}
            emptySubtitle={t('common.unavailable')}
            searchPlaceholder={t('settingsSession.providerUsageGauge.windowTitle')}
            optionTestIDPrefix="settings-session-providerUsageGauge-window"
            icon={<Icon name="chart-line" size={29} color={theme.colors.accent.blue} />}
            minimumSelected={1}
            exclusiveId={['automatic', 'most_constrained']}
        />
        <UsageGaugeLabelsSettingsItem />
    </ItemGroup>;
});
