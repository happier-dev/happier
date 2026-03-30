import { Platform } from 'react-native';
export { blurActiveElementOnWeb, navigateWithBlurOnWeb } from './navigateWithBlurOnWeb';

/**
 * Best-effort helper for web: defer UI state mutations that would immediately
 * re-render/unmount the element handling the current press event.
 *
 * react-native-web's PressResponder can occasionally crash if a Pressable unmounts
 * synchronously during the same click/press dispatch.
 */
export function deferOnWeb(action: () => void): void {
    if (Platform.OS !== 'web') {
        action();
        return;
    }

    let didRun = false;
    const runOnce = (): void => {
        if (didRun) {
            return;
        }
        didRun = true;
        action();
    };

    const raf: ((cb: FrameRequestCallback) => number) | null =
        typeof (globalThis as any).requestAnimationFrame === 'function'
            ? (globalThis as any).requestAnimationFrame.bind(globalThis)
            : null;

    if (raf) {
        raf(() => runOnce());
    }

    setTimeout(runOnce, 0);
}
