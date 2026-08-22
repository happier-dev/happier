import { app, BrowserWindow, ipcMain, protocol, type IpcMainInvokeEvent } from 'electron';

import {
    BRIDGE_CHANNELS,
    isNotImplementedError,
    type BridgeCallbackMessage,
    type BridgeInvokeRequest,
} from '../shared/bridge';
import { describeRequestTarget } from './commands/httpPlugin';
import { createCommandRegistry, describeNotImplemented, runCommand, type WindowMode } from './commands/registry';
import type { CommandArgs, CommandContext } from './commands/types';
import { DesktopEventBus } from './ipc/eventBus';
import { InvokeLog } from './ipc/invokeLog';
import { createMainWindow, presentMainWindow } from './mainWindow';
import { UI_WEB_BUNDLE_DIR } from './paths';
import {
    BUNDLE_ORIGIN,
    BUNDLE_SCHEME,
    BUNDLE_SCHEME_PRIVILEGES,
    createBundleResponder,
} from './renderer/bundleProtocol';
import { encodeRuntimeConfigArgument, readRuntimeConfigFromEnvironment } from './renderer/runtimeConfig';

/** Dev serves the renderer from the Expo dev server; production serves the exported web bundle. */
const DEV_RENDERER_URL = 'http://localhost:8081';

function isDevMode(): boolean {
    return (process.env.HAPPIER_DESKTOP_MODE ?? '').trim().toLowerCase() === 'dev';
}

const eventBus = new DesktopEventBus();
const invokeLog = InvokeLog.fromEnvironment();

let mainWindow: BrowserWindow | null = null;
let windowMode: WindowMode = 'main';

const registry = createCommandRegistry({
    eventBus,
    showMainWindow: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return false;
        presentMainWindow(mainWindow);
        return true;
    },
    setWindowMode: (mode) => {
        windowMode = mode;
        console.log(`[window] mode ${windowMode}`);
    },
    autostart: {
        isEnabled: () => app.getLoginItemSettings().openAtLogin === true,
        setEnabled: (enabled) => {
            app.setLoginItemSettings({ openAtLogin: enabled });
            return app.getLoginItemSettings().openAtLogin === true;
        },
    },
});

function buildCommandContext(event: IpcMainInvokeEvent): CommandContext {
    const window = BrowserWindow.fromWebContents(event.sender);
    return {
        window: window && !window.isDestroyed() ? window : null,
        sender: event.sender,
        emitEvent: (name, payload) => eventBus.emit(name, payload),
        sendCallback: (callbackId, payload) => {
            if (event.sender.isDestroyed()) return;
            const message: BridgeCallbackMessage = { callbackId, payload, once: false };
            event.sender.send(BRIDGE_CHANNELS.callback, message);
        },
    };
}

ipcMain.handle(BRIDGE_CHANNELS.invoke, async (event, request: BridgeInvokeRequest) => {
    const command = String(request?.command ?? '');
    const args: CommandArgs = request?.args ?? {};
    const at = new Date().toISOString();
    const argKeys = Object.keys(args);
    const target = describeRequestTarget(args);
    const base = { at, command, argKeys, ...(target ? { target } : {}) };

    try {
        const outcome = await runCommand(registry, command, args, buildCommandContext(event));
        if (outcome.kind === 'not-implemented') {
            invokeLog.record({ ...base, outcome: 'not-implemented', knownToTauriTarget: outcome.known });
            throw new Error(describeNotImplemented(outcome));
        }
        invokeLog.record({ ...base, outcome: 'implemented' });
        return outcome.value;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isNotImplementedError(message)) {
            invokeLog.record({ ...base, outcome: 'failed', error: message });
        }
        // The Tauri seam surfaces command errors as string rejections; keep that shape.
        throw new Error(message);
    }
});

function resolveRendererUrl(): string {
    return isDevMode() ? DEV_RENDERER_URL : `${BUNDLE_ORIGIN}/`;
}

async function openMainWindow(): Promise<void> {
    const url = resolveRendererUrl();
    const runtimeConfig = readRuntimeConfigFromEnvironment();
    if (runtimeConfig !== null) {
        console.log(`[boot] runtime config ${JSON.stringify(runtimeConfig)}`);
    }
    const window = createMainWindow({
        preloadArguments: runtimeConfig === null ? [] : [encodeRuntimeConfigArgument(runtimeConfig)],
    });
    mainWindow = window;

    window.on('closed', () => {
        eventBus.releaseSender(window.webContents);
        if (mainWindow === window) {
            mainWindow = null;
        }
    });

    // The window is created hidden, exactly like the Tauri target; the renderer asks for it once
    // it is ready, and this is the fallback for the case where it never gets that far.
    window.once('ready-to-show', () => {
        presentMainWindow(window);
    });

    window.webContents.on('render-process-gone', (_event, details) => {
        console.error('[renderer] render process gone', details);
    });

    await window.loadURL(url);
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            presentMainWindow(mainWindow);
        }
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });

    app.on('activate', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            presentMainWindow(mainWindow);
            return;
        }
        void openMainWindow();
    });

    protocol.registerSchemesAsPrivileged([
        { scheme: BUNDLE_SCHEME, privileges: { ...BUNDLE_SCHEME_PRIVILEGES } },
    ]);

    void app.whenReady().then(async () => {
        console.log(`[boot] dev=${isDevMode()}, bundle ${UI_WEB_BUNDLE_DIR}`);
        const respond = createBundleResponder(UI_WEB_BUNDLE_DIR);
        protocol.handle(BUNDLE_SCHEME, (request) => respond(request.url));
        await openMainWindow();
    });
}
