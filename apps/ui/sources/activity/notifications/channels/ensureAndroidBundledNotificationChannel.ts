import { Platform } from 'react-native';
import {
    isPushNotificationBundledSoundId,
    PUSH_NOTIFICATION_BUNDLED_SOUND_FILES,
    PUSH_NOTIFICATION_SOUND_IDS,
    resolvePushNotificationAndroidChannelId,
    type PushNotificationAndroidChannelKind,
} from '@happier-dev/protocol/push/pushNotificationActions';
import { t } from '@/text';
import { loadExpoNotifications } from '@/utils/platform/loadExpoNotifications';

const registeredChannels = new Map<string, Promise<void>>();

/** Android binds the sound when this channel is first created. */
export function ensureAndroidBundledNotificationChannel(
    kind: PushNotificationAndroidChannelKind,
    soundId: string | null | undefined,
): Promise<void> | undefined {
    if (Platform.OS !== 'android' || !isPushNotificationBundledSoundId(soundId)) return;
    // Startup already owns these established channels.
    if (soundId === PUSH_NOTIFICATION_SOUND_IDS.soft || soundId === PUSH_NOTIFICATION_SOUND_IDS.urgent) return;

    const channelId = resolvePushNotificationAndroidChannelId({ kind, soundId });
    const existing = registeredChannels.get(channelId);
    if (existing) return existing;
    const registration = loadExpoNotifications().then(async Notifications => {
        const label = kind === 'permission' ? t('notifications.channels.permissionRequests')
            : kind === 'user_action' ? t('notifications.channels.userActionRequests')
            : t('notifications.channels.default');
        const soundName = soundId[0].toUpperCase() + soundId.slice(1);
        await Notifications.setNotificationChannelAsync(channelId, {
            name: `${label} · ${soundName}`,
            importance: kind === 'user_action' ? Notifications.AndroidImportance.HIGH : Notifications.AndroidImportance.MAX,
            sound: PUSH_NOTIFICATION_BUNDLED_SOUND_FILES[soundId].androidSoundName,
            vibrationPattern: [0, 250, 250, 250],
            lightColor: '#FF231F7C',
            showBadge: true,
        });
    }).catch((error: unknown) => {
        registeredChannels.delete(channelId);
        throw error;
    });
    registeredChannels.set(channelId, registration);
    return registration;
}
