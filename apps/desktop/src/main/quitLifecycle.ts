import type { App, BrowserWindow } from 'electron';

import type { DesktopEventBus } from './ipc/eventBus';

/** The Electron process owns final exit; the shared renderer owns service decisions. */
export class DesktopQuitLifecycle {
    private pending = false;
    private dispatched = false;
    private exiting = false;

    constructor(private readonly dependencies: Readonly<{
        app: Pick<App, 'on' | 'quit' | 'exit'>;
        eventBus: DesktopEventBus;
        ensureMainWindow: () => Promise<void>;
        showMainWindow: () => void;
        shutdownForProcessExit: () => Promise<void>;
    }>) {
        dependencies.app.on('before-quit', (event) => {
            if (this.exiting) return;
            event.preventDefault();
            this.requestQuit();
        });
        dependencies.app.on('window-all-closed', () => {
            if (!this.exiting) this.requestQuit();
        });

        let shutdownStarted = false;
        dependencies.app.on('will-quit', (event) => {
            event.preventDefault();
            if (shutdownStarted) return;
            shutdownStarted = true;
            void dependencies.shutdownForProcessExit()
                .catch((error: unknown) => console.error('[quit] Iroh shutdown failed', error))
                .finally(() => {
                    // All windows have closed and cleanup has settled; finish this exit
                    // instead of re-entering Electron's cancelled quit sequence.
                    dependencies.app.exit(0);
                });
        });
    }

    attachWindow(window: BrowserWindow): void {
        const sender = window.webContents;
        window.on('close', (event) => {
            if (this.exiting) return;
            event.preventDefault();
            this.requestQuit();
        });
        window.on('closed', () => this.dependencies.eventBus.releaseSender(sender));
    }

    /** Called after the event bridge registers the shared renderer's quit listener. */
    rendererListening(eventName: string): void {
        if (eventName === 'desktop_app_exit_requested') this.dispatchPendingRequest();
    }

    finishShutdown(outcome?: 'menuBar'): void {
        if (!this.pending || this.exiting) return;
        this.pending = false;
        this.dispatched = false;
        if (outcome === 'menuBar') {
            // The shared owner uses this result for cancellation/failure. Electron has no tray.
            this.dependencies.showMainWindow();
            return;
        }
        this.exiting = true;
        this.dependencies.app.quit();
    }

    private requestQuit(): void {
        if (this.pending || this.exiting) return;
        this.pending = true;
        void this.dependencies.ensureMainWindow()
            .then(() => this.dispatchPendingRequest())
            .catch((error: unknown) => {
                console.error('[quit] opening the quit handoff window failed', error);
                this.pending = false;
                this.dispatched = false;
            });
    }

    private dispatchPendingRequest(): void {
        if (!this.pending || this.dispatched) return;
        if (this.dependencies.eventBus.listenerCount('desktop_app_exit_requested') === 0) return;
        this.dispatched = true;
        this.dependencies.eventBus.emit('desktop_app_exit_requested', { stopServices: false, menuBarSupported: false });
    }
}
