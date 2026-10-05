import { BrowserWindow } from 'electron';

import type { DesktopEventBus } from './ipc/eventBus';
import { PRELOAD_SCRIPT_PATH } from './paths';
import { readDesktopWindowState } from './windowState';

/**
 * Shape declared for the Tauri target's `main` window in `apps/ui/src-tauri/tauri.conf.json`,
 * expressed with Electron's equivalents so the two targets present the same window.
 *
 * `titleBarStyle: "Overlay"` + `hiddenTitle` on macOS is Electron's `hiddenInset`: transparent
 * title bar, full-size content, inset traffic lights.
 */
export const MAIN_WINDOW_LABEL = 'main';

export function createMainWindow(
    options: Readonly<{
        eventBus: Pick<DesktopEventBus, 'emit'>;
        platform?: NodeJS.Platform;
        preloadArguments?: readonly string[];
    }>,
): BrowserWindow {
    const platform = options.platform ?? process.platform;
    const window = new BrowserWindow({
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
    const publishWindowState = () => {
        options.eventBus.emit('desktopWindow://state', readDesktopWindowState(window));
    };
    window.on('maximize', publishWindowState);
    window.on('unmaximize', publishWindowState);
    window.on('enter-full-screen', publishWindowState);
    window.on('leave-full-screen', publishWindowState);
    return window;
}

/** Mirrors `show_main_window`: present the window and give it focus. */
export function presentMainWindow(window: BrowserWindow): void {
    if (window.isMinimized()) {
        window.restore();
    }
    window.show();
    window.focus();
}
