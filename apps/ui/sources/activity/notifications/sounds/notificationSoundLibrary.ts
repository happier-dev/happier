import type { PushNotificationBundledSoundId } from '@happier-dev/protocol/push/pushNotificationActions';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { randomUUID } from '@/platform/randomUUID';
import { decodeNotificationSound } from './notificationSoundAudio';
import { notificationSoundRecords } from './notificationSoundRecords';
import type { NotificationSoundRecord } from './notificationSoundRecords.types';
import { prepareNotificationSound } from './prepareNotificationSound';

export type { NotificationSoundInfo } from './notificationSoundRecords.types';

export const BUNDLED_NOTIFICATION_SOUND_ASSETS = {
    soft: () => require('../../../assets/sounds/happier_soft.wav'),
    urgent: () => require('../../../assets/sounds/happier_urgent.wav'),
    drop: () => require('../../../assets/sounds/happier_drop.wav'),
    chime: () => require('../../../assets/sounds/happier_chime.wav'),
    chord: () => require('../../../assets/sounds/happier_chord.wav'),
    swell: () => require('../../../assets/sounds/happier_swell.wav'),
    glow: () => require('../../../assets/sounds/happier_glow.wav'),
    flutter: () => require('../../../assets/sounds/happier_flutter.wav'),
    pop: () => require('../../../assets/sounds/happier_pop.wav'),
    blip: () => require('../../../assets/sounds/happier_blip.wav'),
    tap: () => require('../../../assets/sounds/happier_tap.wav'),
    ping: () => require('../../../assets/sounds/happier_ping.wav'),
} satisfies Record<PushNotificationBundledSoundId, () => number>;

function soundLabel(label: string): string {
    const trimmed = label.trim();
    if (!trimmed) throw new Error('notification_sound_label_required');
    return trimmed;
}

async function prepare(bytes: ArrayBuffer) {
    const decoded = await decodeNotificationSound(bytes);
    return prepareNotificationSound(Array.from({ length: decoded.numberOfChannels }, (_, channel) => decoded.getChannelData(channel)));
}

const pendingPluginSounds = new Map<string, Readonly<{ src: string; result: Promise<NotificationSoundRecord> }>>();

async function readCustomSound(id: string): Promise<NotificationSoundRecord | undefined> {
    if (id.startsWith('local/')) return notificationSoundRecords.get(id);
    const sound = readCurrentAppShellPluginUiProjection()?.soundsById?.[id]?.definition;
    if (!sound) return undefined;
    const pending = pendingPluginSounds.get(id);
    if (pending) {
        if (pending.src === sound.src) return pending.result;
        await pending.result.catch(() => undefined);
        return readCustomSound(id);
    }
    const result = (async () => {
        const cached = await notificationSoundRecords.get(id);
        if (cached?.src === sound.src) return cached;
        const response = await fetch(sound.src, { credentials: 'omit' });
        if (!response.ok) throw new Error('notification_sound_download_failed');
        const { bytes, durationSeconds } = await prepare(await response.arrayBuffer());
        const info = { id, label: sound.label, durationSeconds, kind: 'plugin' as const, src: sound.src };
        await notificationSoundRecords.put(info, bytes);
        return { ...info, bytes };
    })().finally(() => pendingPluginSounds.delete(id));
    pendingPluginSounds.set(id, { src: sound.src, result });
    return result;
}

export const notificationSoundLibrary = {
    async put(label: string, input: ArrayBuffer) {
        const name = soundLabel(label);
        const { bytes, durationSeconds, truncated } = await prepare(input);
        const info = { id: `local/${randomUUID()}`, label: name, durationSeconds, kind: 'user' as const };
        await notificationSoundRecords.put(info, bytes);
        return { sound: info, truncated };
    },
    list: notificationSoundRecords.list,
    async rename(id: string, label: string) {
        if (id.startsWith('local/')) return notificationSoundRecords.rename(id, soundLabel(label));
    },
    async remove(id: string) {
        if (id.startsWith('local/')) await notificationSoundRecords.remove(id);
    },
    get: readCustomSound,
};
