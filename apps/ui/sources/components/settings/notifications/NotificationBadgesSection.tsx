import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

type NotificationBadgesSectionProps = Readonly<{
    localSettings: LocalSettings;
    setLocalSetting: (delta: Partial<LocalSettings>) => void;
}>;

export function NotificationBadgesSection({
    localSettings,
    setLocalSetting,
}: NotificationBadgesSectionProps): React.ReactElement {
    const { theme } = useUnistyles();
    const deviceOverrides = localSettings.attentionDeviceOverridesV1;
    const badge = deviceOverrides.badge;
    const disabled = badge.enabled === false;
    const setBadge = React.useCallback((next: Partial<typeof badge>) => {
        setLocalSetting({
            attentionDeviceOverridesV1: {
                ...deviceOverrides,
                badge: {
                    ...badge,
                    ...next,
                },
            },
        });
    }, [badge, deviceOverrides, setLocalSetting]);

    return (
        <ItemGroup
            title={t('settingsNotifications.badges.title')}
            footer={t('settingsNotifications.badges.footer')}
        >
            <Item
                testID="settings-notifications-badges-enabled"
                title={t('settingsNotifications.badges.enabledTitle')}
                subtitle={t('settingsNotifications.badges.enabledSubtitle')}
                icon={<Icon name="stack" size={29} color={theme.colors.accent.blue} />}
                rightElement={(
                    <Switch
                        value={!disabled}
                        onValueChange={(value) => setBadge({ enabled: Boolean(value) })}
                    />
                )}
                showChevron={false}
            />
            <Item
                title={t('settingsNotifications.badges.unreadTitle')}
                subtitle={t('settingsNotifications.badges.unreadSubtitle')}
                icon={<Icon name="envelope-simple-open" size={29} color={theme.colors.text.secondary} />}
                rightElement={(
                    <Switch
                        value={badge.includeUnread !== false}
                        disabled={disabled}
                        onValueChange={(value) => setBadge({ includeUnread: Boolean(value) })}
                    />
                )}
                showChevron={false}
            />
            <Item
                title={t('settingsNotifications.badges.permissionRequestsTitle')}
                subtitle={t('settingsNotifications.badges.permissionRequestsSubtitle')}
                icon={<Icon name="hand" size={29} color={theme.colors.text.secondary} />}
                rightElement={(
                    <Switch
                        value={badge.includePendingPermissionRequests !== false}
                        disabled={disabled}
                        onValueChange={(value) => setBadge({ includePendingPermissionRequests: Boolean(value) })}
                    />
                )}
                showChevron={false}
            />
            <Item
                title={t('settingsNotifications.badges.userActionsTitle')}
                subtitle={t('settingsNotifications.badges.userActionsSubtitle')}
                icon={<Icon name="chat-dots" size={29} color={theme.colors.text.secondary} />}
                rightElement={(
                    <Switch
                        value={badge.includePendingUserActionRequests !== false}
                        disabled={disabled}
                        onValueChange={(value) => setBadge({ includePendingUserActionRequests: Boolean(value) })}
                    />
                )}
                showChevron={false}
            />
            <Item
                title={t('settingsNotifications.badges.queuedTitle')}
                subtitle={t('settingsNotifications.badges.queuedSubtitle')}
                icon={<Icon name="hourglass" size={29} color={theme.colors.text.secondary} />}
                rightElement={(
                    <Switch
                        value={badge.includeQueuedUserInput !== false}
                        disabled={disabled}
                        onValueChange={(value) => setBadge({ includeQueuedUserInput: Boolean(value) })}
                    />
                )}
                showChevron={false}
            />
            <Item
                title={t('settingsNotifications.badges.friendRequestsTitle')}
                subtitle={t('settingsNotifications.badges.friendRequestsSubtitle')}
                icon={<Icon name="users" size={29} color={theme.colors.text.secondary} />}
                rightElement={(
                    <Switch
                        value={badge.includeFriendRequestsInboxCount !== false}
                        disabled={disabled}
                        onValueChange={(value) => setBadge({ includeFriendRequestsInboxCount: Boolean(value) })}
                    />
                )}
                showChevron={false}
            />
            <Item
                title={t('settingsNotifications.badges.desktopDotTitle')}
                subtitle={t('settingsNotifications.badges.desktopDotSubtitle')}
                icon={<Icon name="circle" size={29} color={theme.colors.text.secondary} />}
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
