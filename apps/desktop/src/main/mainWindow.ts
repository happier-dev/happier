import { BrowserWindow } from 'electron';

import { PRELOAD_SCRIPT_PATH } from './paths';

/**
 * Shape declared for the Tauri target's `main` window in `apps/ui/src-tauri/tauri.conf.json`,
 * expressed with Electron's equivalents so the two targets present the same window.
 *
 * `titleBarStyle: "Overlay"` + `hiddenTitle` on macOS is Electron's `hiddenInset`: transparent
 * title bar, full-size content, inset traffic lights.
 */
export const MAIN_WINDOW_LABEL = 'main';

export function createMainWindow(
    options: Readonly<{ platform?: NodeJS.Platform; preloadArguments?: readonly string[] }> = {},
): BrowserWindow {
    const platform = options.platform ?? process.platform;
    return new BrowserWindow({
        title: 'Happier',
        width: 800,
        height: 600,
        show: false,
        frame: true,
        resizable: true,
        fullscreen: false,
        ...(platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
        webPreferences: {
            preload: PRELOAD_SCRIPT_PATH,
            additionalArguments: [...(options.preloadArguments ?? [])],
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webviewTag: false,
        },
    });
}

/** Mirrors `show_main_window`: present the window and give it focus. */
export function presentMainWindow(window: BrowserWindow): void {
    if (window.isMinimized()) {
        window.restore();
    }
    window.show();
    window.focus();
}
