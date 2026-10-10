import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { t } from '@/text';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { NOTIFICATIONS_SETTINGS } from '@/components/settings/notifications/notificationsSettings';
import { updateNotificationBadge } from './notificationPreferences';

type NotificationBadgesSectionProps = Readonly<{
    localSettings: LocalSettings;
    setLocalSetting: (delta: Partial<LocalSettings>) => void;
}>;

export function NotificationBadgesSection({
    localSettings,
    setLocalSetting,
}: NotificationBadgesSectionProps): React.ReactElement {
    const deviceOverrides = localSettings.attentionDeviceOverridesV1;
    const badge = deviceOverrides.badge;
    const disabled = badge.enabled === false;
    const setBadge = React.useCallback((next: Partial<typeof badge>) => {
        setLocalSetting(updateNotificationBadge(localSettings, next));
    }, [localSettings, setLocalSetting]);

    return (
        <ItemGroup
            title={t('settingsNotifications.badges.title')}
            description={t('settingsNotifications.badges.footer')}
        >
            <SettingRow
                testID="settings-notifications-badges-enabled"
                setting={NOTIFICATIONS_SETTINGS.settings.badgesEnabled}
                rightElement={(
                    <Switch
                        value={!disabled}
                        onValueChange={(value) => setBadge({ enabled: Boolean(value) })}
                    />
                )}
                showChevron={false}
            />
            <SettingRow
                setting={NOTIFICATIONS_SETTINGS.settings.unread}
                rightElement={(
                    <Switch
                        value={badge.includeUnread !== false}
                        disabled={disabled}
                        onValueChange={(value) => setBadge({ includeUnread: Boolean(value) })}
                    />
                )}
                showChevron={false}
            />
            <SettingRow
                setting={NOTIFICATIONS_SETTINGS.settings.permissionRequests}
                rightElement={(
                    <Switch
                        value={badge.includePendingPermissionRequests !== false}
                        disabled={disabled}
                        onValueChange={(value) => setBadge({ includePendingPermissionRequests: Boolean(value) })}
                    />
                )}
                showChevron={false}
            />
            <SettingRow
                setting={NOTIFICATIONS_SETTINGS.settings.userActions}
                rightElement={(
                    <Switch
                        value={badge.includePendingUserActionRequests !== false}
                        disabled={disabled}
                        onValueChange={(value) => setBadge({ includePendingUserActionRequests: Boolean(value) })}
                    />
                )}
                showChevron={false}
            />
            <SettingRow
                setting={NOTIFICATIONS_SETTINGS.settings.queued}
                rightElement={(
                    <Switch
                        value={badge.includeQueuedUserInput !== false}
                        disabled={disabled}
                        onValueChange={(value) => setBadge({ includeQueuedUserInput: Boolean(value) })}
                    />
                )}
                showChevron={false}
            />
            <SettingRow
                setting={NOTIFICATIONS_SETTINGS.settings.friendRequests}
                rightElement={(
                    <Switch
                        value={badge.includeFriendRequestsInboxCount !== false}
                        disabled={disabled}
                        onValueChange={(value) => setBadge({ includeFriendRequestsInboxCount: Boolean(value) })}
                    />
                )}
                showChevron={false}
            />
            <SettingRow
                setting={NOTIFICATIONS_SETTINGS.settings.desktopDot}
                rightElement={(
                    <Switch
                        value={badge.includeDesktopNonNumericDot !== false}
                        disabled={disabled}
                        onValueChange={(value) => setBadge({ includeDesktopNonNumericDot: Boolean(value) })}
                    />
                )}
                showChevron={false}
            />
        </ItemGroup>
    );
}
