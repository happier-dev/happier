import * as React from 'react';

import { Switch } from '@/components/ui/forms/Switch';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { t } from '@/text';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { NOTIFICATIONS_SETTINGS } from '@/components/settings/notifications/notificationsSettings';
import {
    areLocalNotificationsOff, readLocalNotificationPreference, resolveLocalNotificationPreferenceDelta, type LocalNotificationPreferenceId,
} from '@/components/settings/notifications/localNotificationPreferences';

type NotificationLocalDeviceSectionProps = Readonly<{
    localSettings: LocalSettings;
    setLocalSetting: (delta: Partial<LocalSettings>) => void;
}>;

export function NotificationLocalDeviceSection({
    localSettings,
    setLocalSetting,
}: NotificationLocalDeviceSectionProps): React.ReactElement {
    const disabled = areLocalNotificationsOff(localSettings);
    const events = localSettings.attentionDeviceOverridesV1.localNotifications.events;
    const read = (id: LocalNotificationPreferenceId) => readLocalNotificationPreference(localSettings, id);
    const write = (id: LocalNotificationPreferenceId, value: boolean) =>
        setLocalSetting(resolveLocalNotificationPreferenceDelta(localSettings, id, value));

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
                        onValueChange={(value) => write('enabled', Boolean(value))}
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
                        onValueChange={(value) => write('ready', Boolean(value))}
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
                        onValueChange={(value) => write('readyPreview', Boolean(value))}
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
                        onValueChange={(value) => write('requestPreview', Boolean(value))}
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
                        onValueChange={(value) => write('permissionRequests', Boolean(value))}
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
                        onValueChange={(value) => write('userActions', Boolean(value))}
                    />
                )}
                showChevron={false}
            />
        </ItemGroup>
    );
}
