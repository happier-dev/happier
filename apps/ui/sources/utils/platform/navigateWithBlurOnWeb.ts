import { Platform } from 'react-native';

export function blurActiveElementOnWeb(): void {
    if (Platform.OS !== 'web') return;
    if (typeof document === 'undefined') return;

    const activeElement = document.activeElement as { blur?: (() => void) | undefined } | null;
    activeElement?.blur?.();
}

export function navigateWithBlurOnWeb(action: () => void): void {
    blurActiveElementOnWeb();
    action();
}
