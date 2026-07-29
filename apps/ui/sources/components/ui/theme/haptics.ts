import * as Haptics from 'expo-haptics';

export async function hapticsError(): Promise<void> {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
}

export async function hapticsLight(): Promise<void> {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}
