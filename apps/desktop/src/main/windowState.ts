import type { BrowserWindow } from 'electron';

/** The shared renderer contract, sampled from the native window for reads and notifications. */
export function readDesktopWindowState(
    window: Pick<BrowserWindow, 'isMaximized' | 'isFullScreen'> | null,
): Readonly<{ isMaximized: boolean; isFullscreen: boolean }> {
    return {
        isMaximized: window?.isMaximized() === true,
        isFullscreen: window?.isFullScreen() === true,
    };
}
