import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { AttentionDeviceOverridesV1 } from '@/sync/domains/settings/attentionDeviceOverridesV1';
import { t } from '@/text';
import { PUSH_NOTIFICATION_SOUND_IDS, type AttentionDeliveryPolicyV1 } from '@happier-dev/protocol';
import { Icon } from '@/components/ui/icons/Icon';

type NotificationSoundsSectionProps = Readonly<{
    policy: AttentionDeliveryPolicyV1;
    deviceOverrides: AttentionDeviceOverridesV1;
    previewSupported: boolean;
    setAccountSoundPreset: (preset: 'happier' | 'system' | 'silent') => void;
    setDeviceSoundsEnabled: (enabled: boolean) => void;
    previewSound: () => void;
}>;

export function NotificationSoundsSection({
    policy,
    deviceOverrides,
    previewSupported,
    setAccountSoundPreset,
    setDeviceSoundsEnabled,
    previewSound,
}: NotificationSoundsSectionProps): React.ReactElement {
    const { theme } = useUnistyles();
    const accountSoundId = policy.sounds.defaultSoundId;
    const permissionRequestSoundId =
        policy.sounds.eventSoundIds.permission_request
        ?? (accountSoundId === PUSH_NOTIFICATION_SOUND_IDS.soft ? PUSH_NOTIFICATION_SOUND_IDS.urgent : undefined);
    const userActionRequestSoundId =
        policy.sounds.eventSoundIds.user_action_request
        ?? (accountSoundId === PUSH_NOTIFICATION_SOUND_IDS.soft ? PUSH_NOTIFICATION_SOUND_IDS.urgent : undefined);
    const usesHappierSounds =
        accountSoundId === PUSH_NOTIFICATION_SOUND_IDS.soft
        && permissionRequestSoundId === PUSH_NOTIFICATION_SOUND_IDS.urgent
        && userActionRequestSoundId === PUSH_NOTIFICATION_SOUND_IDS.urgent;

    return (
        <ItemGroup
            title={t('settingsNotifications.sounds.title')}
            footer={t('settingsNotifications.sounds.footer')}
        >
            <Item
                testID="settings-notifications-sounds-account-happier"
                title={t('settingsNotifications.sounds.accountHappierTitle')}
                subtitle={t('settingsNotifications.sounds.accountHappierSubtitle')}
                icon={<Icon name="sparkle" size={29} color={theme.colors.accent.blue} />}
                selected={usesHappierSounds}
                onPress={() => setAccountSoundPreset('happier')}
                showChevron={false}
            />
            <Item
                testID="settings-notifications-sounds-account-system"
                title={t('settingsNotifications.sounds.accountDefaultTitle')}
                subtitle={t('settingsNotifications.sounds.accountDefaultSubtitle')}
                icon={<Icon name="speaker-high" size={29} color={theme.colors.accent.blue} />}
                selected={accountSoundId === PUSH_NOTIFICATION_SOUND_IDS.systemDefault}
                onPress={() => setAccountSoundPreset('system')}
                showChevron={false}
            />
            <Item
                testID="settings-notifications-sounds-account-silent"
                title={t('settingsNotifications.sounds.accountSilentTitle')}
                subtitle={t('settingsNotifications.sounds.accountSilentSubtitle')}
                icon={<Icon name="speaker-slash" size={29} color={theme.colors.text.secondary} />}
                selected={accountSoundId === PUSH_NOTIFICATION_SOUND_IDS.none}
                onPress={() => setAccountSoundPreset('silent')}
                showChevron={false}
            />
            <Item
                testID="settings-notifications-sounds-device-enabled"
                title={t('settingsNotifications.sounds.deviceEnabledTitle')}
                subtitle={t('settingsNotifications.sounds.deviceEnabledSubtitle')}
                icon={<Icon name="device-mobile" size={29} color={theme.colors.text.secondary} />}
                rightElement={(
                    <Switch
                        value={deviceOverrides.sounds.enabled !== false}
                        onValueChange={(value) => setDeviceSoundsEnabled(Boolean(value))}
                    />
                )}
                showChevron={false}
            />
            {previewSupported ? (
                <Item
                    testID="settings-notifications-sounds-preview"
                    title={t('settingsNotifications.sounds.previewTitle')}
                    subtitle={t('settingsNotifications.sounds.previewSubtitle')}
                    icon={<Icon name="play-circle" size={29} color={theme.colors.accent.blue} />}
                    onPress={previewSound}
                />
            ) : null}
        </ItemGroup>
    );
}
