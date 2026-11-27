import { isPushNotificationBundledSoundId } from '@happier-dev/protocol/push/pushNotificationActions';
import { playNotificationAudio } from './notificationSoundAudio';
import { BUNDLED_NOTIFICATION_SOUND_ASSETS, notificationSoundLibrary } from './notificationSoundLibrary';
import type { NotificationCue } from './notificationCue';

let playing = false;
let autoplayBlocked = false;
const autoplayListeners = new Set<() => void>();

export const readNotificationAutoplayBlocked = (): boolean => autoplayBlocked;
export function subscribeNotificationAutoplayBlocked(listener: () => void): () => void {
    autoplayListeners.add(listener);
    return () => { autoplayListeners.delete(listener); };
}

function setAutoplayBlocked(blocked: boolean): void {
    if (autoplayBlocked === blocked) return;
    autoplayBlocked = blocked;
    for (const listener of autoplayListeners) listener();
}

/** Both notification delivery and picker preview use the same one-at-a-time player. */
export async function playNotificationSound({ id, fallbackSoundId, volume }: NotificationCue): Promise<boolean> {
    if (playing || volume <= 0) return false;
    playing = true;
    try {
        const bytes = isPushNotificationBundledSoundId(id) ? BUNDLED_NOTIFICATION_SOUND_ASSETS[id]()
            : (await notificationSoundLibrary.get(id).catch(() => undefined))?.bytes;
        const source = bytes ?? (fallbackSoundId ? BUNDLED_NOTIFICATION_SOUND_ASSETS[fallbackSoundId]() : undefined);
        if (source === undefined) return false;
        await playNotificationAudio(source, volume);
        setAutoplayBlocked(false);
        return true;
    } catch (error) {
        if (typeof document !== 'undefined' && error instanceof Error && error.name === 'NotAllowedError') {
            setAutoplayBlocked(true);
        }
        throw error;
    } finally {
        playing = false;
    }
}
