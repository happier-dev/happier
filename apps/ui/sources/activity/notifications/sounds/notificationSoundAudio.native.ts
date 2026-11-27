import { File, Paths } from 'expo-file-system';
import { randomUUID } from '@/platform/randomUUID';
import { hasActiveNativeVoiceAudioMode } from '@/voice/runtime/voiceAudioMode';
import { NOTIFICATION_SOUND_SAMPLE_RATE } from './prepareNotificationSound';

export async function decodeNotificationSound(bytes: ArrayBuffer) {
    const { AudioContext } = await import('react-native-audio-api');
    const context = new AudioContext({ sampleRate: NOTIFICATION_SOUND_SAMPLE_RATE, initSuspended: true });
    try {
        return await context.decodeAudioData(bytes);
    } finally {
        await context.close();
    }
}

export async function playNotificationAudio(source: number | ArrayBuffer, volume: number): Promise<void> {
    const { createAudioPlayer } = await import('expo-audio');
    if (hasActiveNativeVoiceAudioMode()) return;
    const file = typeof source === 'number' ? null : new File(Paths.cache, `notification-sound-${randomUUID()}.wav`);
    try {
        if (file && source instanceof ArrayBuffer) file.write(new Uint8Array(source));
        const player = createAudioPlayer(file?.uri ?? source as number, { keepAudioSessionActive: true });
        try {
            player.volume = volume;
            await new Promise<void>((resolve, reject) => {
                player.addListener('playbackStatusUpdate', status => {
                    if (status.didJustFinish || hasActiveNativeVoiceAudioMode()) resolve();
                    else if (status.playbackState === 'error') reject(new Error('notification_sound_playback_failed'));
                });
                player.play();
            });
        } finally {
            player.remove();
        }
    } finally {
        if (file?.exists) file.delete();
    }
}
