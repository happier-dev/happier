import * as React from 'react';

import { Switch } from '@/components/ui/forms/Switch';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { NOTIFICATIONS_SETTINGS } from '@/components/settings/notifications/notificationsSettings';
import { Icon } from '@/components/ui/icons/Icon';

type NotificationPushSectionProps = Readonly<{
    homeName: string;
    pushEnabled: boolean;
    /** The channel catalog has not answered yet, so the switch's value is unknown: draw no switch rather than a wrong one. */
    pending?: boolean;
    setPushEnabled: (enabled: boolean) => void;
    mutePhoneWhenComputerFocused: boolean;
    setMutePhoneWhenComputerFocused: (enabled: boolean) => void;
    openPushTroubleshooting: () => void;
}>;

export function NotificationPushSection({
    homeName,
    pushEnabled,
    pending = false,
    setPushEnabled,
    mutePhoneWhenComputerFocused,
    setMutePhoneWhenComputerFocused,
    openPushTroubleshooting,
}: NotificationPushSectionProps): React.ReactElement {

    return (
        <>
        <ItemGroup
            title={t('settingsNotifications.push.title')}
            description={t('settingsNotifications.push.footer', { home: homeName })}
        >
            <SettingRow
                testID="settings-notifications-push-enabled"
                setting={NOTIFICATIONS_SETTINGS.settings.pushEnabled}
                subtitle={t('settingsNotifications.push.enabledSubtitle', { home: homeName })}
                rightElement={pending ? undefined : (
                    <Switch
                        value={pushEnabled}
                        onValueChange={(value) => setPushEnabled(Boolean(value))}
                    />
                )}
                showChevron={false}
            />
            <SettingRow
                testID="settings-notifications-mute-phone-focused-computer"
                setting={NOTIFICATIONS_SETTINGS.settings.mutePhoneWhenComputerFocused}
                rightElement={(
                    <Switch value={mutePhoneWhenComputerFocused}
                        onValueChange={(value) => setMutePhoneWhenComputerFocused(Boolean(value))} />
                )}
                showChevron={false}
            />
        </ItemGroup>
        {/* A row that opens a page carries an icon, so it gets its own sheet: beside the switches it pushed their titles off the page's edge. */}
        <ItemGroup>
            <SettingRow
                testID="settings-notifications-push-troubleshoot"
                icon={<Icon name="question" />}
                setting={NOTIFICATIONS_SETTINGS.settings.troubleshoot}
                onPress={openPushTroubleshooting}
            />
        </ItemGroup>
        </>
    );
}
