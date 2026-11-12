import * as React from 'react';
import { Platform } from 'react-native';

import { Switch } from '@/components/ui/forms/Switch';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { t } from '@/text';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { NOTIFICATIONS_SETTINGS } from '@/components/settings/notifications/notificationsSettings';
import {
    areLocalNotificationsOff, readLocalNotificationPreference, type LocalNotificationPreferenceId,
} from '@/components/settings/notifications/localNotificationPreferences';
import type { DeclaredSettingsWrite } from '@/components/settings/shell/useSettingActionFeedback';
import { requestWebLocalNotificationPermission } from '@/activity/notifications/channels/sendWebLocalNotification';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { fireAndForget } from '@/utils/system/fireAndForget';

type NotificationLocalDeviceSectionProps = Readonly<{
    localSettings: Pick<LocalSettings, 'attentionDeviceOverridesV1'>;
    setSetting: DeclaredSettingsWrite;
}>;

export function NotificationLocalDeviceSection({
    localSettings,
    setSetting,
}: NotificationLocalDeviceSectionProps): React.ReactElement {
    const disabled = areLocalNotificationsOff(localSettings);
    const events = localSettings.attentionDeviceOverridesV1.localNotifications.events;
    const read = (id: LocalNotificationPreferenceId) => readLocalNotificationPreference(localSettings, id);

    return (
        <ItemGroup
            title={t('settingsNotifications.local.title')}
            description={t('settingsNotifications.local.footer')}
        >
            <SettingRow
                testID="settings-notifications-local-enabled"
                setting={NOTIFICATIONS_SETTINGS.settings.localEnabled}
                rightElement={(
                    <Switch
                        value={read('enabled')}
                        onValueChange={(value) => {
                            const enabled = Boolean(value);
                            void setSetting(NOTIFICATIONS_SETTINGS.settings.localEnabled, enabled);
                            // Browsers only show their permission prompt for a user gesture. The
                            // desktop app requests permission from its own permission row.
                            if (enabled && Platform.OS === 'web' && !isDesktopHost()) {
                                fireAndForget(requestWebLocalNotificationPermission(), {
                                    tag: 'NotificationLocalDeviceSection.requestWebLocalNotificationPermission',
                                });
                            }
                        }}
                    />
                )}
                showChevron={false}
            />
            <SettingRow
                setting={NOTIFICATIONS_SETTINGS.settings.ready}
                rightElement={(
                    <Switch
                        value={read('ready')}
                        disabled={disabled}
                        onValueChange={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.ready, Boolean(value)); }}
                    />
                )}
                showChevron={false}
            />
            <SettingRow
                setting={NOTIFICATIONS_SETTINGS.settings.readyPreview}
                rightElement={(
                    <Switch
                        value={read('readyPreview')}
                        disabled={disabled || events.ready === false}
                        onValueChange={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.readyPreview, Boolean(value)); }}
                    />
                )}
                showChevron={false}
            />
            <SettingRow
                setting={NOTIFICATIONS_SETTINGS.settings.requestPreview}
                rightElement={(
                    <Switch
                        value={read('requestPreview')}
                        disabled={disabled || (events.permission_request === false && events.user_action_request === false)}
                        onValueChange={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.requestPreview, Boolean(value)); }}
                    />
                )}
                showChevron={false}
            />
            <SettingRow
                setting={NOTIFICATIONS_SETTINGS.settings.localPermissionRequests}
                rightElement={(
                    <Switch
                        value={read('permissionRequests')}
                        disabled={disabled}
                        onValueChange={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.localPermissionRequests, Boolean(value)); }}
                    />
                )}
                showChevron={false}
            />
            <SettingRow
                setting={NOTIFICATIONS_SETTINGS.settings.localUserActions}
                rightElement={(
                    <Switch
                        value={read('userActions')}
                        disabled={disabled}
                        onValueChange={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.localUserActions, Boolean(value)); }}
                    />
                )}
                showChevron={false}
            />
        </ItemGroup>
    );
}
