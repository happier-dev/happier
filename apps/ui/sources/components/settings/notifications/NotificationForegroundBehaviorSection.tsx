import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

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
                icon={<Icon name="arrows-clockwise" size={29} color={theme.colors.text.secondary} />}
                selected={deviceOverrides.foregroundBehavior === 'account'}
                disabled={deviceOverrides.enabled === false}
                onPress={() => setForegroundBehavior('account')}
                showChevron={false}
            />
            <Item
                testID="settings-notifications-foreground-full"
                title={t('settingsNotifications.foregroundBehavior.full')}
                subtitle={t('settingsNotifications.foregroundBehavior.fullDescription')}
                icon={<Icon name="speaker-high" size={29} color={theme.colors.accent.blue} />}
                selected={deviceOverrides.foregroundBehavior === 'full'}
                disabled={disabled}
                onPress={() => setForegroundBehavior('full')}
                showChevron={false}
            />
            <Item
                testID="settings-notifications-foreground-silent"
                title={t('settingsNotifications.foregroundBehavior.silent')}
                subtitle={t('settingsNotifications.foregroundBehavior.silentDescription')}
                icon={<Icon name="speaker-slash" size={29} color={theme.colors.accent.blue} />}
                selected={deviceOverrides.foregroundBehavior === 'silent'}
                disabled={disabled}
                onPress={() => setForegroundBehavior('silent')}
                showChevron={false}
            />
            <Item
                testID="settings-notifications-foreground-off"
                title={t('settingsNotifications.foregroundBehavior.off')}
                subtitle={t('settingsNotifications.foregroundBehavior.offDescription')}
                icon={<Icon name="bell-slash" size={29} color={theme.colors.accent.blue} />}
                selected={deviceOverrides.foregroundBehavior === 'off'}
                disabled={disabled}
                onPress={() => setForegroundBehavior('off')}
                showChevron={false}
            />
        </ItemGroup>
    );
}
