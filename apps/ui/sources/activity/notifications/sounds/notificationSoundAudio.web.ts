import { Asset } from 'expo-asset';
import { NOTIFICATION_SOUND_SAMPLE_RATE } from './prepareNotificationSound';

export async function decodeNotificationSound(bytes: ArrayBuffer): Promise<AudioBuffer> {
    const context = new OfflineAudioContext(1, 1, NOTIFICATION_SOUND_SAMPLE_RATE);
    return await context.decodeAudioData(bytes.slice(0));
}

export async function playNotificationAudio(source: number | ArrayBuffer, volume: number): Promise<void> {
    const objectUrl = typeof source === 'number' ? null : URL.createObjectURL(new Blob([source], { type: 'audio/wav' }));
    try {
        const audio = new Audio(objectUrl ?? Asset.fromModule(source as number).uri);
        audio.volume = volume;
        await new Promise<void>((resolve, reject) => {
            audio.onended = () => resolve();
            audio.onerror = () => reject(new Error('notification_sound_playback_failed'));
            audio.play().catch(reject);
        });
    } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
}
