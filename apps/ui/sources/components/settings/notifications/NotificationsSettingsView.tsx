import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';

import { sync } from '@/sync/sync';
import { useSettings } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { DEFAULT_NOTIFICATIONS_SETTINGS_V1, NotificationsSettingsV1Schema } from '@happier-dev/protocol';

type ForegroundBehavior = 'full' | 'silent' | 'off';

export const NotificationsSettingsView = React.memo(function NotificationsSettingsView() {
    const { theme } = useUnistyles();
    const settings = useSettings();

    const notificationsRaw = (settings as any)?.notificationsSettingsV1;
    const notifications = React.useMemo(() => {
        try {
            return NotificationsSettingsV1Schema.parse(notificationsRaw);
        } catch {
            return DEFAULT_NOTIFICATIONS_SETTINGS_V1;
        }
    }, [notificationsRaw]);

    const pushEnabled = notifications.pushEnabled !== false;
    const foregroundBehavior: ForegroundBehavior = notifications.foregroundBehavior ?? 'full';

    const setNotifications = React.useCallback((next: Partial<typeof notifications>) => {
        sync.applySettings({
            notificationsSettingsV1: {
                ...notifications,
                ...next,
                v: 1,
            },
        } as any);
    }, [notifications]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settingsNotifications.push.title')}
                footer={t('settingsNotifications.push.footer')}
            >
                <Item
                    title={t('common.enabled')}
                    subtitle={t('settingsNotifications.push.enabledSubtitle')}
                    icon={<Ionicons name="notifications-outline" size={29} color={theme.colors.accent.blue} />}
                    rightElement={(
                        <Switch
                            value={pushEnabled}
                            onValueChange={(value) => setNotifications({ pushEnabled: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsNotifications.types.title')}
                footer={t('settingsNotifications.types.footer')}
            >
                <Item
                    title={t('settingsNotifications.types.ready.title')}
                    subtitle={t('settingsNotifications.types.ready.subtitle')}
                    icon={<Ionicons name="checkmark-circle-outline" size={29} color={theme.colors.success} />}
                    rightElement={(
                        <Switch
                            value={notifications.ready !== false}
                            disabled={!pushEnabled}
                            onValueChange={(value) => setNotifications({ ready: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.types.permissionRequests.title')}
                    subtitle={t('settingsNotifications.types.permissionRequests.subtitle')}
                    icon={<Ionicons name="hand-left-outline" size={29} color={theme.colors.textSecondary} />}
                    rightElement={(
                        <Switch
                            value={notifications.permissionRequest !== false}
                            disabled={!pushEnabled}
                            onValueChange={(value) => setNotifications({ permissionRequest: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.types.userActions.title')}
                    subtitle={t('settingsNotifications.types.userActions.subtitle')}
                    icon={<Ionicons name="chatbox-ellipses-outline" size={29} color={theme.colors.textSecondary} />}
                    rightElement={(
                        <Switch
                            value={notifications.userActionRequest !== false}
                            disabled={!pushEnabled}
                            onValueChange={(value) => setNotifications({ userActionRequest: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsNotifications.foregroundBehavior.title')}
                footer={t('settingsNotifications.foregroundBehavior.footer')}
            >
                <Item
                    title={t('settingsNotifications.foregroundBehavior.full')}
                    subtitle={t('settingsNotifications.foregroundBehavior.fullDescription')}
                    icon={<Ionicons name="volume-high-outline" size={29} color={theme.colors.accent.blue} />}
                    selected={foregroundBehavior === 'full'}
                    disabled={!pushEnabled}
                    onPress={() => setNotifications({ foregroundBehavior: 'full' })}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.foregroundBehavior.silent')}
                    subtitle={t('settingsNotifications.foregroundBehavior.silentDescription')}
                    icon={<Ionicons name="volume-off-outline" size={29} color={theme.colors.accent.blue} />}
                    selected={foregroundBehavior === 'silent'}
                    disabled={!pushEnabled}
                    onPress={() => setNotifications({ foregroundBehavior: 'silent' })}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.foregroundBehavior.off')}
                    subtitle={t('settingsNotifications.foregroundBehavior.offDescription')}
                    icon={<Ionicons name="notifications-off-outline" size={29} color={theme.colors.accent.blue} />}
                    selected={foregroundBehavior === 'off'}
                    disabled={!pushEnabled}
                    onPress={() => setNotifications({ foregroundBehavior: 'off' })}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
});
