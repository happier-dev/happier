import * as React from 'react';

import { Switch } from '@/components/ui/forms/Switch';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { AttentionDeviceOverridesV1 } from '@/sync/domains/settings/attentionDeviceOverridesV1';
import { t } from '@/text';
import { PUSH_NOTIFICATION_SOUND_IDS } from '@happier-dev/protocol/push/pushNotificationActions';
import type { AttentionDeliveryPolicyV1 } from '@happier-dev/protocol/account/settings/accountSettings';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import { NOTIFICATIONS_SETTINGS } from '@/components/settings/notifications/notificationsSettings';

/** `custom` is a sound set the presets do not describe; it is shown, never offered. */
type SoundPresetChoice = 'happier' | 'system' | 'silent' | 'custom';

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

    const preset: SoundPresetChoice = usesHappierSounds
        ? 'happier'
        : accountSoundId === PUSH_NOTIFICATION_SOUND_IDS.systemDefault
            ? 'system'
            : accountSoundId === PUSH_NOTIFICATION_SOUND_IDS.none ? 'silent' : 'custom';

    return (
        <ItemGroup
            title={t('settingsNotifications.sounds.title')}
            description={t('settingsNotifications.sounds.footer')}
        >
            <SettingAnchor setting={NOTIFICATIONS_SETTINGS.settings.soundPreset}>
                <SegmentedChoiceItem<SoundPresetChoice>
                    // Remount when the sounds leave the presets so no stale selection stays drawn.
                    key={preset === 'custom' ? 'custom' : 'preset'}
                    testID="settings-notifications-sounds-account"
                    testIDPrefix="settings-notifications-sounds-account"
                    title={t(NOTIFICATIONS_SETTINGS.settings.soundPreset.titleKey)}
                    subtitle={t('settingsNotifications.sounds.customSubtitle')}
                    subtitleLines={0}
                    value={preset}
                    onChange={(next) => { if (next !== 'custom') setAccountSoundPreset(next); }}
                    options={[
                        { id: 'happier', label: t('settingsNotifications.sounds.accountHappierShort'), description: t('settingsNotifications.sounds.accountHappierSubtitle') },
                        { id: 'system', label: t('settingsNotifications.sounds.accountDefaultShort'), description: t('settingsNotifications.sounds.accountDefaultSubtitle') },
                        { id: 'silent', label: t('settingsNotifications.sounds.accountSilentTitle'), description: t('settingsNotifications.sounds.accountSilentSubtitle') },
                    ]}
                />
            </SettingAnchor>
            <SettingRow
                testID="settings-notifications-sounds-device-enabled"
                setting={NOTIFICATIONS_SETTINGS.settings.deviceEnabled}
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
                    title={t('settingsNotifications.sounds.previewTitle')}
                    subtitle={t('settingsNotifications.sounds.previewSubtitle')}
                    showChevron={false}
                    rightElement={(
                        <RoundButton
                            testID="settings-notifications-sounds-preview"
                            size="small"
                            display="secondary"
                            title={t('settingsNotifications.sounds.previewAction')}
                            onPress={previewSound}
                        />
                    )}
                />
            ) : null}
        </ItemGroup>
    );
}
