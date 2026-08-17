import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

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
                icon={<Icon name="device-mobile" size={29} color={theme.colors.accent.blue} />}
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
                icon={<Icon name="check-circle" size={29} color={theme.colors.state.success.foreground} />}
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
                icon={<Icon name="chat-circle-dots" size={29} color={theme.colors.text.secondary} />}
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
                icon={<Icon name="hand" size={29} color={theme.colors.text.secondary} />}
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
                icon={<Icon name="chat-dots" size={29} color={theme.colors.text.secondary} />}
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
