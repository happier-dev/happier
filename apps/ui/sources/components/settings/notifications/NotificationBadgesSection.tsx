import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { t } from '@/text';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { NOTIFICATIONS_SETTINGS } from '@/components/settings/notifications/notificationsSettings';
import type { DeclaredSettingsWrite } from '@/components/settings/shell/useSettingActionFeedback';

type NotificationBadgesSectionProps = Readonly<{
    localSettings: Pick<LocalSettings, 'attentionDeviceOverridesV1'>;
    setSetting: DeclaredSettingsWrite;
}>;

export function NotificationBadgesSection({
    localSettings,
    setSetting,
}: NotificationBadgesSectionProps): React.ReactElement {
    const deviceOverrides = localSettings.attentionDeviceOverridesV1;
    const badge = deviceOverrides.badge;
    const disabled = badge.enabled === false;

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
                        onValueChange={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.badgesEnabled, Boolean(value)); }}
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
                        onValueChange={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.unread, Boolean(value)); }}
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
                        onValueChange={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.permissionRequests, Boolean(value)); }}
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
                        onValueChange={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.userActions, Boolean(value)); }}
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
                        onValueChange={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.queued, Boolean(value)); }}
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
                        onValueChange={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.friendRequests, Boolean(value)); }}
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
                        onValueChange={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.desktopDot, Boolean(value)); }}
                    />
                )}
                showChevron={false}
            />
        </ItemGroup>
    );
}
