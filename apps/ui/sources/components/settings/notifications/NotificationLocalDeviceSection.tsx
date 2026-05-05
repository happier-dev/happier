import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { t } from '@/text';

type NotificationLocalDeviceSectionProps = Readonly<{
    localSettings: LocalSettings;
    setLocalSetting: (delta: Partial<LocalSettings>) => void;
}>;

export function NotificationLocalDeviceSection({
    localSettings,
    setLocalSetting,
}: NotificationLocalDeviceSectionProps): React.ReactElement {
    const { theme } = useUnistyles();
    const deviceOverrides = localSettings.attentionDeviceOverridesV1;
    const localNotifications = deviceOverrides.localNotifications;
    const disabled = deviceOverrides.enabled === false || localNotifications.enabled === false;
    const setLocalNotifications = React.useCallback((
        next: Partial<typeof localNotifications>,
    ) => {
        setLocalSetting({
            attentionDeviceOverridesV1: {
                ...deviceOverrides,
                localNotifications: {
                    ...localNotifications,
                    ...next,
                },
            },
        });
    }, [deviceOverrides, localNotifications, setLocalSetting]);
    const setLocalNotificationEvent = React.useCallback((
        event: keyof typeof localNotifications.events,
        enabled: boolean,
    ) => {
        setLocalNotifications({
            events: {
                ...localNotifications.events,
                [event]: enabled,
            },
        });
    }, [localNotifications.events, setLocalNotifications]);

    return (
        <ItemGroup
            title={t('settingsNotifications.local.title')}
            footer={t('settingsNotifications.local.footer')}
        >
            <Item
                testID="settings-notifications-local-enabled"
                title={t('common.enabled')}
                subtitle={t('settingsNotifications.local.enabledSubtitle')}
                icon={<Ionicons name="phone-portrait-outline" size={29} color={theme.colors.accent.blue} />}
                rightElement={(
                    <Switch
                        value={!disabled}
                        onValueChange={(value) => setLocalNotifications({ enabled: Boolean(value) })}
                    />
                )}
                showChevron={false}
            />
            <Item
                title={t('settingsNotifications.local.readyTitle')}
                subtitle={t('settingsNotifications.local.readySubtitle')}
                icon={<Ionicons name="checkmark-circle-outline" size={29} color={theme.colors.success} />}
                rightElement={(
                    <Switch
                        value={localNotifications.events.ready !== false}
                        disabled={disabled}
                        onValueChange={(value) => setLocalNotificationEvent('ready', Boolean(value))}
                    />
                )}
                showChevron={false}
            />
            <Item
                title={t('settingsNotifications.local.readyPreviewTitle')}
                subtitle={t('settingsNotifications.local.readyPreviewSubtitle')}
                icon={<Ionicons name="chatbubble-ellipses-outline" size={29} color={theme.colors.textSecondary} />}
                rightElement={(
                    <Switch
                        value={localNotifications.previewBehavior !== 'status_only'}
                        disabled={disabled || localNotifications.events.ready === false}
                        onValueChange={(value) => setLocalNotifications({
                            previewBehavior: Boolean(value) ? 'account' : 'status_only',
                        })}
                    />
                )}
                showChevron={false}
            />
            <Item
                title={t('settingsNotifications.local.permissionRequestsTitle')}
                subtitle={t('settingsNotifications.local.permissionRequestsSubtitle')}
                icon={<Ionicons name="hand-left-outline" size={29} color={theme.colors.textSecondary} />}
                rightElement={(
                    <Switch
                        value={localNotifications.events.permission_request !== false}
                        disabled={disabled}
                        onValueChange={(value) => setLocalNotificationEvent('permission_request', Boolean(value))}
                    />
                )}
                showChevron={false}
            />
            <Item
                title={t('settingsNotifications.local.userActionsTitle')}
                subtitle={t('settingsNotifications.local.userActionsSubtitle')}
                icon={<Ionicons name="chatbox-ellipses-outline" size={29} color={theme.colors.textSecondary} />}
                rightElement={(
                    <Switch
                        value={localNotifications.events.user_action_request !== false}
                        disabled={disabled}
                        onValueChange={(value) => setLocalNotificationEvent('user_action_request', Boolean(value))}
                    />
                )}
                showChevron={false}
            />
        </ItemGroup>
    );
}
