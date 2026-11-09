import { BrowserWindow, shell } from 'electron';

import type { DesktopEventBus } from './ipc/eventBus';
import { PRELOAD_SCRIPT_PATH } from './paths';
import { readDesktopWindowState } from './windowState';
import type { DesktopWindowChrome } from './windowChrome';
import { BUNDLE_ORIGIN } from './renderer/bundleProtocol';
import { isExternalWebUrl, isRendererOrigin } from './renderer/security';

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
        windowChrome: DesktopWindowChrome;
        preloadArguments?: readonly string[];
        rendererUrl?: string;
    }>,
): BrowserWindow {
    const window = new BrowserWindow({
        title: 'Happier',
        width: 800,
        height: 600,
        show: false,
        ...options.windowChrome.prepareWindow(),
        resizable: true,
        fullscreen: false,
        webPreferences: {
            preload: PRELOAD_SCRIPT_PATH,
            additionalArguments: [...(options.preloadArguments ?? [])],
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webviewTag: false,
        },
    });
    const rendererUrl = options.rendererUrl ?? `${BUNDLE_ORIGIN}/`;
    window.webContents.on('will-navigate', (event) => {
        if (!isRendererOrigin(event.url, rendererUrl)) event.preventDefault();
    });
    window.webContents.on('will-redirect', (event) => {
        if (event.isMainFrame && !isRendererOrigin(event.url, rendererUrl)) event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
        if (isExternalWebUrl(url)) {
            void shell.openExternal(url).catch(() => console.error('[window] external link could not be opened'));
        }
        return { action: 'deny' };
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
