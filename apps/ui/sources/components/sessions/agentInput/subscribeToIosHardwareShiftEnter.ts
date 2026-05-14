import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type NativeHardwareKeyboardEvent = Readonly<{
    key: string;
    code?: string;
    characters?: string;
    modifiers: Readonly<{
        shift: boolean;
        ctrl: boolean;
        meta: boolean;
        alt: boolean;
    }>;
    repeat: boolean;
    target: string;
}>;

type HappierHardwareKeyboardShortcutsModule = {
    addListener: {
        (eventName: 'hardwareKey', listener: (event: NativeHardwareKeyboardEvent) => void): { remove(): void };
        (eventName: 'shiftEnter', listener: () => void): { remove(): void };
    };
    setHardwareKeyEventsEnabled?: (enabled: boolean) => void;
    setHardwareKeyConsumableEventSignatures?: (signatures: readonly string[]) => void;
    setShiftEnterEnabled?: (enabled: boolean) => void;
};

let activeHardwareKeySubscriptions = 0;

function readNativeModule(): HappierHardwareKeyboardShortcutsModule | null {
    return Platform.OS === 'ios' || Platform.OS === 'android'
        ? (requireOptionalNativeModule('HappierHardwareKeyboardShortcuts') as HappierHardwareKeyboardShortcutsModule | null)
        : null;
}

function setHardwareKeyEventsEnabled(nativeModule: HappierHardwareKeyboardShortcutsModule, enabled: boolean): void {
    nativeModule.setHardwareKeyEventsEnabled?.(enabled);
}

export function configureNativeHardwareKeyboardConsumableEventSignatures(signatures: readonly string[]): void {
    const nativeModule = readNativeModule();
    nativeModule?.setHardwareKeyConsumableEventSignatures?.(signatures);
}

export function subscribeToNativeHardwareKeyboardEvents(
    listener: (event: NativeHardwareKeyboardEvent) => void,
): { remove(): void } | null {
    const nativeModule = readNativeModule();
    if (!nativeModule?.setHardwareKeyEventsEnabled) {
        return null;
    }

    const subscription = nativeModule.addListener('hardwareKey', listener);
    activeHardwareKeySubscriptions += 1;
    if (activeHardwareKeySubscriptions === 1) {
        setHardwareKeyEventsEnabled(nativeModule, true);
    }

    let removed = false;

    return {
        remove: () => {
            if (removed) {
                return;
            }
            removed = true;
            subscription.remove();
            activeHardwareKeySubscriptions = Math.max(0, activeHardwareKeySubscriptions - 1);
            if (activeHardwareKeySubscriptions === 0) {
                setHardwareKeyEventsEnabled(nativeModule, false);
                nativeModule.setHardwareKeyConsumableEventSignatures?.([]);
            }
        },
    };
}

export function subscribeToIosHardwareShiftEnter(listener: () => void): { remove(): void } | null {
    const nativeModule = readNativeModule();
    if (!nativeModule?.setShiftEnterEnabled) {
        return null;
    }

    // Legacy composer wiring owns only pure Shift+Enter. Generic shortcut consumers
    // must subscribe through subscribeToNativeHardwareKeyboardEvents separately.
    const subscription = nativeModule.addListener('shiftEnter', listener);
    nativeModule.setShiftEnterEnabled(true);

    return {
        remove: () => {
            nativeModule.setShiftEnterEnabled?.(false);
            subscription.remove();
        },
    };
}
