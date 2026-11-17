import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { resolveEffectiveAttentionDeliveryPolicy } from '@/activity/delivery/resolveActivityAttentionDeliveryPlan';
import { resolveThemeMode, useApplyThemeSelection } from '@/components/settings/appearance/useApplyThemeSelection';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SEGMENTED_TAB_ICON_SIZE_PX } from '@/components/ui/navigation/SegmentedTabBar';
import type { ThemePreference } from '@/components/ui/layout/statusBarStyle';
import { useLocalSetting, useLocalSettingMutable, useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

/**
 * What notifications do on this device, in a few words: whether push is on and whether quiet hours
 * apply. It reads the same effective policy delivery decisions use.
 */
export function useNotificationsSummary(): string {
    const accountPolicy = useSetting('attentionDeliveryPolicyV1');
    const deviceOverrides = useLocalSetting('attentionDeviceOverridesV1');
    return React.useMemo(() => {
        const policy = resolveEffectiveAttentionDeliveryPolicy({
            accountSettings: { attentionDeliveryPolicyV1: accountPolicy },
            localSettings: { attentionDeviceOverridesV1: deviceOverrides },
        });
        const parts = [
            policy.channels.expo_push.enabled !== false
                ? t('settingsOverview.notificationsPushOn')
                : t('settingsOverview.notificationsPushOff'),
            ...(policy.quietHours.enabled === true && policy.quietHours.windows.length > 0
                ? [t('settingsOverview.notificationsQuietHours')]
                : []),
        ];
        return parts.join(' · ');
    }, [accountPolicy, deviceOverrides]);
}

/** The preferences people change most, one tap from the Settings home. Each page stays the owner. */
export const HubQuickSettingsSection = React.memo(function HubQuickSettingsSection() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const [themePreference] = useLocalSettingMutable('themePreference');
    const applyThemeSelection = useApplyThemeSelection();
    const notificationsSummary = useNotificationsSummary();
    const iconColor = theme.colors.text.secondary;
    const themeOptions = React.useMemo(() => [
        { id: 'adaptive' as const, label: t('settingsAppearance.themeOptions.adaptive'), icon: <Icon name="circle-half" size={SEGMENTED_TAB_ICON_SIZE_PX} color={iconColor} /> },
        { id: 'light' as const, label: t('settingsAppearance.themeOptions.light'), icon: <Icon name="sun" size={SEGMENTED_TAB_ICON_SIZE_PX} color={iconColor} /> },
        { id: 'dark' as const, label: t('settingsAppearance.themeOptions.dark'), icon: <Icon name="moon" size={SEGMENTED_TAB_ICON_SIZE_PX} color={iconColor} /> },
    ], [iconColor]);

    return (
        <ItemGroup title={t('settingsOverview.quickSettingsTitle')}>
            <SegmentedChoiceItem<ThemePreference>
                testID="settings-overview-theme"
                testIDPrefix="settings-overview-theme"
                title={t('settingsAppearance.theme')}
                options={themeOptions}
                value={resolveThemeMode(themePreference)}
                onChange={(next) => applyThemeSelection(next)}
            />
            <Item
                testID="settings-overview-notifications"
                title={t('settings.notifications')}
                subtitle={notificationsSummary}
                icon={<Icon name="bell" />}
                onPress={() => router.push(SETTINGS_ROUTES.notifications as never)}
            />
        </ItemGroup>
    );
});
