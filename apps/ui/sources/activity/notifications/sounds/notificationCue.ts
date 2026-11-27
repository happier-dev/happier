import type { AttentionDeliveryDecision } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicy';
import type { PushNotificationBundledSoundId } from '@happier-dev/protocol/push/pushNotificationActions';

type SoundDevicePreferences = Readonly<{ enabled?: boolean; inApp?: boolean; volume?: number }>;
export type NotificationCue = Readonly<{ id: string; fallbackSoundId?: PushNotificationBundledSoundId; volume: number }>;

export function resolveInAppNotificationSounds(inApp: boolean | undefined, desktop: boolean): boolean {
    return inApp ?? desktop;
}

export function resolveNotificationCue(
    decision: AttentionDeliveryDecision,
    host: 'desktop' | 'browser' | 'native',
    preferences: SoundDevicePreferences,
): NotificationCue | null {
    if (decision.delivery !== 'deliver' || preferences.enabled === false) return null;
    const { sound } = decision;
    if (!sound.id || (sound.kind !== 'bundled' && sound.kind !== 'custom')) return null;
    if (host === 'native' ? sound.kind !== 'custom' : !resolveInAppNotificationSounds(preferences.inApp, host === 'desktop')) return null;
    const volume = preferences.volume ?? sound.volume;
    return {
        id: sound.id,
        ...(sound.fallbackSoundId ? { fallbackSoundId: sound.fallbackSoundId } : {}),
        volume,
    };
}

/** The accepted notification's stable tag is also the cross-tab playback lock. */
export async function playNotificationCue(cue: NotificationCue, browserTag?: string): Promise<void> {
    const play = async () => {
        const { playNotificationSound } = await import('./playNotificationSound');
        await playNotificationSound(cue);
    };
    if (browserTag && typeof navigator !== 'undefined' && navigator.locks) {
        await navigator.locks.request(browserTag, { ifAvailable: true }, lock => lock ? play() : Promise.resolve());
        return;
    }
    await play();
}
