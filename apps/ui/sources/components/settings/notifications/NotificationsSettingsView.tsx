import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';

import { sync } from '@/sync/sync';
import { useSettings } from '@/sync/domains/state/storage';

import { DEFAULT_NOTIFICATIONS_SETTINGS_V1, NotificationsSettingsV1Schema } from '@happier-dev/protocol';

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
                title="Push notifications"
                footer="These notifications are sent from your CLI via Expo when your session needs attention."
            >
                <Item
                    title="Enabled"
                    subtitle="Allow push notifications on this account"
                    icon={<Ionicons name="notifications-outline" size={29} color="#007AFF" />}
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
                title="Types"
                footer="Disable individual types if you only want certain alerts."
            >
                <Item
                    title="Ready"
                    subtitle="Notify when a turn finishes and the agent is waiting for your command"
                    icon={<Ionicons name="checkmark-circle-outline" size={29} color="#34C759" />}
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
                    title="Permission requests"
                    subtitle="Notify when a session is blocked waiting for an approval"
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
            </ItemGroup>
        </ItemList>
    );
});

