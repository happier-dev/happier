import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';

async function emitHaptic(
    name: string,
    ios: () => Promise<void>,
    android: () => Promise<void>,
): Promise<void> {
    if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
    // Read through the registered store rather than importing/initializing it from
    // this leaf. A change to the device preference takes effect on the next event.
    if (readRegisteredStorageState()?.localSettings.hapticsEnabled === false) return;
    try {
        if (Platform.OS === 'android') await android();
        else await ios();
    } catch {
        // Cosmetic device feedback must never reject the user's action. Keep a
        // real native failure observable without logging user interaction data.
        console.warn(`Haptic feedback failed (${name}).`);
    }
}

export function hapticsError(): Promise<void> {
    return emitHaptic('error', () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
        () => Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Reject));
}

export function hapticsLight(): Promise<void> {
    return emitHaptic('light', () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
        () => Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Context_Click));
}

export function hapticsSelection(): Promise<void> {
    return emitHaptic('selection', () => Haptics.selectionAsync(),
        () => Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Segment_Tick));
}

export function hapticsDragStart(): Promise<void> {
    return emitHaptic('drag-start', () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
        () => Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Drag_Start));
}
