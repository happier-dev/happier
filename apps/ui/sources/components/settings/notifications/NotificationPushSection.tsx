import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

type NotificationPushSectionProps = Readonly<{
    pushEnabled: boolean;
    setPushEnabled: (enabled: boolean) => void;
    openPushTroubleshooting: () => void;
}>;

export function NotificationPushSection({
    pushEnabled,
    setPushEnabled,
    openPushTroubleshooting,
}: NotificationPushSectionProps): React.ReactElement {
    const { theme } = useUnistyles();

    return (
        <ItemGroup
            title={t('settingsNotifications.push.title')}
            footer={t('settingsNotifications.push.footer')}
        >
            <Item
                testID="settings-notifications-push-enabled"
                title={t('common.enabled')}
                subtitle={t('settingsNotifications.push.enabledSubtitle')}
                icon={<Icon name="bell" size={29} color={theme.colors.accent.blue} />}
                rightElement={(
                    <Switch
                        value={pushEnabled}
                        onValueChange={(value) => setPushEnabled(Boolean(value))}
                    />
                )}
                showChevron={false}
            />
            <Item
                testID="settings-notifications-push-troubleshoot"
                title={t('settingsNotifications.push.troubleshootTitle')}
                subtitle={t('settingsNotifications.push.troubleshootSubtitle')}
                icon={<Icon name="question" size={29} color={theme.colors.text.secondary} />}
                onPress={openPushTroubleshooting}
            />
        </ItemGroup>
    );
}
