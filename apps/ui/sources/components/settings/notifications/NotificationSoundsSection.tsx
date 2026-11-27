import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { playNotificationSound } from '@/activity/notifications/sounds/playNotificationSound';
import { resolveInAppNotificationSounds } from '@/activity/notifications/sounds/notificationCue';
import { Switch } from '@/components/ui/forms/Switch';
import { Slider } from '@/components/ui/forms/Slider';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { Text } from '@/components/ui/text/Text';
import type { AttentionDeviceOverridesV1 } from '@/sync/domains/settings/attentionDeviceOverridesV1';
import { t } from '@/text';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import type { AttentionDeliveryPolicyV1 } from '@happier-dev/protocol/account/settings/accountSettings';
import { PUSH_NOTIFICATION_SOUND_IDS } from '@happier-dev/protocol/push/pushNotificationActions';
import { HAPPIER_MENU_ROW_METRICS } from '@happier-dev/plugin-ui/presentation';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { NOTIFICATIONS_SETTINGS } from '@/components/settings/notifications/notificationsSettings';
import { readAccountNotificationEventSound, type NotificationSoundEvent, type NotificationSoundPreset } from './notificationPreferences';
import { addNotificationSound } from './AddNotificationSoundDialog';
import { NotificationEventSoundRow } from './NotificationEventSoundRow';
import { bundledNotificationSoundLabel, happierFallbackSound } from './notificationSoundChoices';
import { useNotificationSoundSources } from './useNotificationSoundSources';

/** The rows in the Types section's order; each declaration names its row. */
const SOUND_EVENT_ROWS: ReadonlyArray<Readonly<{ event: NotificationSoundEvent; setting: SettingRef }>> = [
    { event: 'ready', setting: NOTIFICATIONS_SETTINGS.settings.soundReady },
    { event: 'permission_request', setting: NOTIFICATIONS_SETTINGS.settings.soundPermissionRequests },
    { event: 'user_action_request', setting: NOTIFICATIONS_SETTINGS.settings.soundUserActions },
    { event: 'task_failed', setting: NOTIFICATIONS_SETTINGS.settings.soundFailed },
    { event: 'follow_update', setting: NOTIFICATIONS_SETTINGS.settings.soundFollowing },
];

type NotificationSoundsSectionProps = Readonly<{
    policy: AttentionDeliveryPolicyV1;
    deviceOverrides: AttentionDeviceOverridesV1;
    setAllSounds: (preset: NotificationSoundPreset) => void;
    setEventSound: (setting: SettingRef, soundId: string) => void;
    setDeviceSoundsEnabled: (enabled: boolean) => void;
    setInAppSounds: (enabled: boolean) => void;
    setVolume: (volume: number) => void;
}>;

export function NotificationSoundsSection({
    policy,
    deviceOverrides,
    setAllSounds,
    setEventSound,
    setDeviceSoundsEnabled,
    setInAppSounds,
    setVolume,
}: NotificationSoundsSectionProps): React.ReactElement {
    const sources = useNotificationSoundSources();
    const desktop = isDesktopHost();
    // Phones play Happier's sounds through the OS and their own and plugin sounds in the app while open,
    // so the in-app switch and volume belong to the web and desktop hosts.
    const appPlayback = Platform.OS === 'web';
    const volume = deviceOverrides.sounds.volume ?? 1;
    const volumeRef = React.useRef(volume);
    volumeRef.current = volume;

    const chooseSound = React.useCallback((event: NotificationSoundEvent, soundId: string) => {
        setEventSound(SOUND_EVENT_ROWS.find(row => row.event === event)!.setting, soundId);
        if (soundId === PUSH_NOTIFICATION_SOUND_IDS.none || soundId === PUSH_NOTIFICATION_SOUND_IDS.systemDefault) return;
        playNotificationSound({ id: soundId, fallbackSoundId: happierFallbackSound(event), volume: volumeRef.current }).catch(() => undefined);
    }, [setEventSound]);

    const { reloadPersonal } = sources;
    const addSound = React.useCallback((event: NotificationSoundEvent) => {
        const row = SOUND_EVENT_ROWS.find(entry => entry.event === event)!;
        void addNotificationSound({
            eventTitle: row.setting.title ?? t(row.setting.titleKey),
            fallbackLabel: bundledNotificationSoundLabel(happierFallbackSound(event)),
            onAdded: (sound) => {
                void reloadPersonal().then(() => chooseSound(event, sound.id));
            },
        });
    }, [chooseSound, reloadPersonal]);

    return (
        <ItemGroup
            title={t('settingsNotifications.sounds.title')}
            description={t('settingsNotifications.sounds.footer')}
            action={<SetAllSoundsMenu setAllSounds={setAllSounds} />}
        >
            {SOUND_EVENT_ROWS.map(({ event, setting }) => (
                <SettingAnchor key={event} setting={setting}>
                    <NotificationEventSoundRow
                        event={event}
                        title={setting.title ?? t(setting.titleKey)}
                        soundId={readAccountNotificationEventSound(policy, event)}
                        sources={sources}
                        chooseSound={chooseSound}
                        addSound={addSound}
                    />
                </SettingAnchor>
            ))}
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
            {appPlayback ? (
                <SettingAnchor setting={NOTIFICATIONS_SETTINGS.settings.inAppSounds}>
                    <Item
                        testID="settings-notifications-sounds-in-app"
                        title={t(desktop ? 'settingsNotifications.sounds.inAppDesktopTitle' : 'settingsNotifications.sounds.inAppBrowserTitle')}
                        subtitle={t('settingsNotifications.sounds.inAppSubtitle')}
                        showChevron={false}
                        rightElement={(
                            <Switch
                                value={resolveInAppNotificationSounds(deviceOverrides.sounds.inApp, desktop)}
                                onValueChange={(value) => setInAppSounds(Boolean(value))}
                            />
                        )}
                    />
                </SettingAnchor>
            ) : null}
            {appPlayback ? <NotificationVolumeRow volume={volume} setVolume={setVolume} /> : null}
        </ItemGroup>
    );
}

const SET_ALL_PRESETS: readonly NotificationSoundPreset[] = ['happier', 'system', 'silent'];

/** An action, not a mode: it writes every event row once and shows no current value. */
function SetAllSoundsMenu({ setAllSounds }: Readonly<{ setAllSounds: (preset: NotificationSoundPreset) => void }>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const items = React.useMemo<readonly DropdownMenuItem[]>(() => [
        {
            id: 'happier',
            title: t('settingsNotifications.sounds.accountHappierTitle'),
            rightElement: (
                <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
                    {[bundledNotificationSoundLabel('soft'), bundledNotificationSoundLabel('urgent'), bundledNotificationSoundLabel('drop')].join(' · ')}
                </Text>
            ),
        },
        { id: 'system', title: t('settingsNotifications.sounds.setAllSystem') },
        { id: 'silent', title: t('settingsNotifications.sounds.accountSilentTitle') },
    ], [theme.colors.text.secondary]);
    return (
        <SettingAnchor setting={NOTIFICATIONS_SETTINGS.settings.soundPreset}>
            <DropdownMenu
                testID="settings-notifications-sounds-set-all"
                open={open}
                onOpenChange={setOpen}
                items={items}
                selectedId={null}
                allowEmptySelection
                matchTriggerWidth={false}
                popoverAnchorAlign="end"
                onSelect={(id) => {
                    const preset = SET_ALL_PRESETS.find(candidate => candidate === id);
                    if (preset) setAllSounds(preset);
                }}
                footer={(
                    <Text variant="meta" style={{ color: theme.colors.text.secondary, paddingHorizontal: HAPPIER_MENU_ROW_METRICS.paddingHorizontalPx, paddingVertical: theme.space.s10 }}>
                        {t('settingsNotifications.sounds.setAllNote')}
                    </Text>
                )}
                trigger={({ open: expanded, toggle }) => (
                    <SectionActionButton
                        testID="settings-notifications-sounds-set-all-trigger"
                        title={t('settingsNotifications.sounds.setAll')}
                        expanded={expanded}
                        onPress={toggle}
                    />
                )}
            />
        </SettingAnchor>
    );
}

/** Device volume for the sounds the app plays itself; it commits once when the drag ends. */
function NotificationVolumeRow({ volume, setVolume }: Readonly<{ volume: number; setVolume: (volume: number) => void }>) {
    const { theme } = useUnistyles();
    const [preview, setPreview] = React.useState<number | undefined>(undefined);
    const percent = preview ?? Math.round(volume * 100);
    return (
        <SettingAnchor setting={NOTIFICATIONS_SETTINGS.settings.soundVolume}>
            <Item
                testID="settings-notifications-sounds-volume"
                title={t('settingsNotifications.sounds.volumeTitle')}
                subtitle={`${percent}%`}
                showChevron={false}
                accessoryLayout="adaptive"
                rightElement={(
                    <Slider
                        testID="settings-notifications-sounds-volume-slider"
                        value={Math.round(volume * 100)}
                        min={0}
                        max={100}
                        step={5}
                        trackWidth={220}
                        accessibilityLabel={t('settingsNotifications.sounds.volumeTitle')}
                        formatValueText={(next) => `${next}%`}
                        leading={<Icon name="speaker-low" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />}
                        trailing={<Icon name="speaker-high" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
                        onValuePreview={setPreview}
                        onValueChange={(next) => setVolume(next / 100)}
                    />
                )}
            />
        </SettingAnchor>
    );
}
