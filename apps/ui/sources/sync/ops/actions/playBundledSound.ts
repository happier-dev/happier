import { Asset } from 'expo-asset';
import { Platform } from 'react-native';
import { PUSH_NOTIFICATION_SOUND_IDS, type PushNotificationBundledSoundId } from '@happier-dev/protocol/push/pushNotificationActions';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import soft from '@/assets/sounds/happier_soft.wav';
import urgent from '@/assets/sounds/happier_urgent.wav';

const bundledSoundAssets = { soft, urgent } satisfies Record<PushNotificationBundledSoundId, number>;

export function resolveNotificationSoundPreviewTarget(): 'desktop' | 'native' | 'unsupported' {
    return isDesktopHost() ? 'desktop' : Platform.OS === 'web' ? 'unsupported' : 'native';
}

/** Resolving a bundled asset does not fetch it; Audio is created only at the person's operation. */
export async function playBundledSound(id: PushNotificationBundledSoundId): Promise<void> {
    const audio = new Audio(Asset.fromModule(bundledSoundAssets[id]).uri);
    // Leave volume and mute with the webview's normal OS audio output.
    await audio.play();
}

export async function playCaptureSound(enabled: boolean): Promise<void> {
    if (!enabled) return;
    // Optional confirmation must never prevent opening or delivering a completed capture.
    try { await playBundledSound(PUSH_NOTIFICATION_SOUND_IDS.soft); } catch { /* Playback may be refused by the OS/webview. */ }
}
