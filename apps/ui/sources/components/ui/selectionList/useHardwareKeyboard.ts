import * as React from 'react';
import { Platform } from 'react-native';

type MediaQueryListLike = Readonly<{
    matches?: boolean;
    addEventListener?: (event: 'change', callback: () => void) => void;
    removeEventListener?: (event: 'change', callback: () => void) => void;
    addListener?: (callback: () => void) => void;
    removeListener?: (callback: () => void) => void;
}>;

type HardwareKeyboardWindow = Readonly<{
    matchMedia?: (query: string) => MediaQueryListLike | null | undefined;
}>;

type HardwareKeyboardNavigator = Readonly<{
    maxTouchPoints?: number;
}>;

function readWindow(): HardwareKeyboardWindow | undefined {
    return (globalThis as { window?: HardwareKeyboardWindow }).window;
}

function readNavigator(): HardwareKeyboardNavigator | undefined {
    return (globalThis as { navigator?: HardwareKeyboardNavigator }).navigator;
}

export function useHardwareKeyboard(): boolean {
    const [hasKeyboard, setHasKeyboard] = React.useState<boolean>(() => detectHardwareKeyboard());

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const win = readWindow();
        if (!win?.matchMedia) return;
        const query = win.matchMedia('(pointer: fine)');
        if (!query) return;
        const onChange = () => setHasKeyboard(detectHardwareKeyboard());
        if (typeof query.addEventListener === 'function') {
            query.addEventListener('change', onChange);
            return () => query.removeEventListener?.('change', onChange);
        }
        if (typeof query.addListener === 'function') {
            query.addListener(onChange);
            return () => query.removeListener?.(onChange);
        }
        return undefined;
    }, []);

    return hasKeyboard;
}

function detectHardwareKeyboard(): boolean {
    if (Platform.OS !== 'web') return false;
    const win = readWindow();
    if (!win?.matchMedia) return false;
    if (!win.matchMedia('(pointer: fine)')?.matches) return false;
    const nav = readNavigator();
    const touchPoints = typeof nav?.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0;
    return touchPoints === 0;
}
