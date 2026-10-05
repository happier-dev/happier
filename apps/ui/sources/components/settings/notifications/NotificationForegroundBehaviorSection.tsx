import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { NOTIFICATIONS_SETTINGS } from '@/components/settings/notifications/notificationsSettings';
import { areLocalNotificationsOff, resolveLocalNotificationForegroundDelta } from '@/components/settings/notifications/localNotificationPreferences';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { t } from '@/text';

type NotificationForegroundBehaviorSectionProps = Readonly<{
    localSettings: LocalSettings;
    setLocalSetting: (delta: Partial<LocalSettings>) => void;
}>;

type ForegroundBehavior = LocalSettings['attentionDeviceOverridesV1']['foregroundBehavior'];

export function NotificationForegroundBehaviorSection({
    localSettings,
    setLocalSetting,
}: NotificationForegroundBehaviorSectionProps): React.ReactElement {
    const deviceOverrides = localSettings.attentionDeviceOverridesV1;
    // Banners and sounds inside the app need this device's notifications; the synced default
    // stays selectable whenever this device follows the Account at all.
    const localNotificationsOff = areLocalNotificationsOff(localSettings);
    const setForegroundBehavior = React.useCallback((foregroundBehavior: ForegroundBehavior) => {
        setLocalSetting(resolveLocalNotificationForegroundDelta(localSettings, foregroundBehavior));
    }, [localSettings, setLocalSetting]);

    return (
        <ItemGroup
            title={t('settingsNotifications.foregroundBehavior.title')}
            description={t('settingsNotifications.foregroundBehavior.footer')}
        >
            <SettingAnchor setting={NOTIFICATIONS_SETTINGS.settings.foregroundBehavior}>
                <SegmentedChoiceItem<ForegroundBehavior>
                    testID="settings-notifications-foreground"
                    testIDPrefix="settings-notifications-foreground"
                    title={t(NOTIFICATIONS_SETTINGS.settings.foregroundBehavior.titleKey)}
                    subtitle={localNotificationsOff ? t('settingsNotifications.foregroundBehavior.needsDeviceNotifications') : undefined}
                    subtitleLines={0}
                    disabled={deviceOverrides.enabled === false}
                    value={deviceOverrides.foregroundBehavior}
                    onChange={setForegroundBehavior}
                    options={[
                        {
                            id: 'account',
                            label: t('settingsNotifications.foregroundBehavior.accountShort'),
                            description: t('settingsNotifications.foregroundBehavior.accountDescription'),
                        },
                        {
                            id: 'full',
                            label: t('settingsNotifications.foregroundBehavior.full'),
                            // Needs this device's notifications; the row says so while they are off.
                            disabled: localNotificationsOff,
                            description: localNotificationsOff ? undefined : t('settingsNotifications.foregroundBehavior.fullDescription'),
                        },
                        {
                            id: 'silent',
                            label: t('settingsNotifications.foregroundBehavior.silent'),
                            // Needs this device's notifications; the row says so while they are off.
                            disabled: localNotificationsOff,
                            description: localNotificationsOff ? undefined : t('settingsNotifications.foregroundBehavior.silentDescription'),
                        },
                        {
                            id: 'off',
                            label: t('settingsNotifications.foregroundBehavior.off'),
                            // Needs this device's notifications; the row says so while they are off.
                            disabled: localNotificationsOff,
                            description: localNotificationsOff ? undefined : t('settingsNotifications.foregroundBehavior.offDescription'),
                        },
                    ]}
                />
            </SettingAnchor>
        </ItemGroup>
    );
}
