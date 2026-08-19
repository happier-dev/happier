import * as Haptics from 'expo-haptics';

export function hapticsError() {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
}

export function hapticsLight() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

export function hapticsSelection() {
    Haptics.selectionAsync();
}
