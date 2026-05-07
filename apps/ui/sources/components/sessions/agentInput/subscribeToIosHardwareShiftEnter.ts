import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

type HappierHardwareKeyboardShortcutsModule = {
    addListener: (eventName: 'shiftEnter', listener: () => void) => { remove(): void };
    setShiftEnterEnabled: (enabled: boolean) => void;
};

const nativeModule =
    Platform.OS === 'ios'
        ? (requireOptionalNativeModule('HappierHardwareKeyboardShortcuts') as HappierHardwareKeyboardShortcutsModule | null)
        : null;

export function subscribeToIosHardwareShiftEnter(listener: () => void): { remove(): void } | null {
    if (!nativeModule) {
        return null;
    }

    const subscription = nativeModule.addListener('shiftEnter', listener);
    nativeModule.setShiftEnterEnabled(true);

    return {
        remove: () => {
            nativeModule.setShiftEnterEnabled(false);
            subscription.remove();
        },
    };
}
