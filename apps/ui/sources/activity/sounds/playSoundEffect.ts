import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import { canPlaySoundEffectNow, prepareSoundEffectAudioSession } from '@/voice/runtime/voiceAudioMode';

import type { SoundEffectId } from './soundEffectCatalog';
import { SOUND_EFFECT_SOURCES } from './soundEffectSources';

type HappierQuietModeModule = Readonly<{
    isQuietModeActive(): boolean;
}>;

let reportedMissingQuietModeModule = false;

/**
 * Android plays sound effects as media audio, which Do Not Disturb and a silent or vibrate ringer
 * do not mute, so the device's quiet state is read explicitly. An unreadable state counts as
 * quiet: staying silent is the safe failure for a sound that must obey Do Not Disturb.
 */
function isAndroidQuietModeActive(): boolean {
    const native = requireOptionalNativeModule<HappierQuietModeModule>('HappierQuietMode');
    if (!native) {
        if (!reportedMissingQuietModeModule) {
            reportedMissingQuietModeModule = true;
            console.warn('[soundEffects] HappierQuietMode native module is missing; sound effects stay silent');
        }
        return true;
    }
    try {
        return native.isQuietModeActive() === true;
    } catch (error) {
        console.warn('[soundEffects] Unable to read Do Not Disturb state; sound effects stay silent', error);
        return true;
    }
}

/** Plays one sound effect unless the device is in a quiet mode. */
export async function playSoundEffect(id: SoundEffectId): Promise<void> {
    if (Platform.OS === 'android' && isAndroidQuietModeActive()) return;
    if (!(await prepareSoundEffectAudioSession())) return;

    const { createAudioPlayer } = await import('expo-audio');
    if (!canPlaySoundEffectNow()) return;

    let player: ReturnType<typeof createAudioPlayer> | null = null;
    let subscription: { remove(): void } | null = null;
    let released = false;
    // `remove()` is expo-audio's call that frees a player made by `createAudioPlayer`.
    const release = () => {
        if (released) return;
        released = true;
        try {
            subscription?.remove();
        } finally {
            player?.remove();
        }
    };

    try {
        player = createAudioPlayer(SOUND_EFFECT_SOURCES[id]);
        subscription = player.addListener('playbackStatusUpdate', (status) => {
            if (status.didJustFinish) release();
        });
        player.play();
    } catch (error) {
        release();
        throw error;
    }
}
