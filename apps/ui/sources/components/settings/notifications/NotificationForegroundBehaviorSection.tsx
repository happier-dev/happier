import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { t } from '@/text';

type NotificationForegroundBehaviorSectionProps = Readonly<{
    localSettings: LocalSettings;
    setLocalSetting: (delta: Partial<LocalSettings>) => void;
}>;

export function NotificationForegroundBehaviorSection({
    localSettings,
    setLocalSetting,
}: NotificationForegroundBehaviorSectionProps): React.ReactElement {
    const { theme } = useUnistyles();
    const deviceOverrides = localSettings.attentionDeviceOverridesV1;
    const disabled = deviceOverrides.enabled === false || deviceOverrides.localNotifications.enabled === false;
    const setForegroundBehavior = React.useCallback((foregroundBehavior: typeof deviceOverrides.foregroundBehavior) => {
        setLocalSetting({
            attentionDeviceOverridesV1: {
                ...deviceOverrides,
                foregroundBehavior,
            },
        });
    }, [deviceOverrides, setLocalSetting]);

    return (
        <ItemGroup
            title={t('settingsNotifications.foregroundBehavior.title')}
            footer={t('settingsNotifications.foregroundBehavior.footer')}
        >
            <Item
                testID="settings-notifications-foreground-account"
                title={t('settingsNotifications.foregroundBehavior.account')}
                subtitle={t('settingsNotifications.foregroundBehavior.accountDescription')}
                icon={<Ionicons name="sync-outline" size={29} color={theme.colors.textSecondary} />}
                selected={deviceOverrides.foregroundBehavior === 'account'}
                disabled={deviceOverrides.enabled === false}
                onPress={() => setForegroundBehavior('account')}
                showChevron={false}
            />
            <Item
                testID="settings-notifications-foreground-full"
                title={t('settingsNotifications.foregroundBehavior.full')}
                subtitle={t('settingsNotifications.foregroundBehavior.fullDescription')}
                icon={<Ionicons name="volume-high-outline" size={29} color={theme.colors.accent.blue} />}
                selected={deviceOverrides.foregroundBehavior === 'full'}
                disabled={disabled}
                onPress={() => setForegroundBehavior('full')}
                showChevron={false}
            />
            <Item
                testID="settings-notifications-foreground-silent"
                title={t('settingsNotifications.foregroundBehavior.silent')}
                subtitle={t('settingsNotifications.foregroundBehavior.silentDescription')}
                icon={<Ionicons name="volume-off-outline" size={29} color={theme.colors.accent.blue} />}
                selected={deviceOverrides.foregroundBehavior === 'silent'}
                disabled={disabled}
                onPress={() => setForegroundBehavior('silent')}
                showChevron={false}
            />
            <Item
                testID="settings-notifications-foreground-off"
                title={t('settingsNotifications.foregroundBehavior.off')}
                subtitle={t('settingsNotifications.foregroundBehavior.offDescription')}
                icon={<Ionicons name="notifications-off-outline" size={29} color={theme.colors.accent.blue} />}
                selected={deviceOverrides.foregroundBehavior === 'off'}
                disabled={disabled}
                onPress={() => setForegroundBehavior('off')}
                showChevron={false}
            />
        </ItemGroup>
    );
}
