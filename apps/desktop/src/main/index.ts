import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, shell, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';

import {
    BRIDGE_CHANNELS,
    isNotImplementedError,
    type BridgeCallbackMessage,
    type BridgeInvokeRequest,
} from '../shared/bridge';
import { describeRequestTarget } from './commands/httpPlugin';
import { ElectronDesktopFiles } from './commands/desktopFiles';
import { resolveHsetupPath } from './commands/hsetupPath';
import { ElectronIrohTunnelService } from './commands/irohTunnel';
import { createCommandRegistry, describeNotImplemented, runCommand, type WindowMode } from './commands/registry';
import { ElectronSecureStorage } from './commands/secureStorage';
import { ElectronSystemTasks } from './commands/systemTasks';
import type { CommandArgs, CommandContext } from './commands/types';
import { DesktopEventBus } from './ipc/eventBus';
import { InvokeLog } from './ipc/invokeLog';
import { createLoginItemWriter } from './loginItem';
import { createMainWindow, presentMainWindow } from './mainWindow';
import { UI_WEB_BUNDLE_DIR } from './paths';
import { DesktopQuitLifecycle } from './quitLifecycle';
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
let quitLifecycle: DesktopQuitLifecycle | null = null;

// Loaded only in the main process; the renderer/preload never touch the addon.
const irohTunnel = new ElectronIrohTunnelService({
    userDataPath: () => app.getPath('userData'),
});

const systemTasks = new ElectronSystemTasks({
    resolveHsetupPath: () => resolveHsetupPath({
        explicitPath: process.env.HAPPIER_HSETUP_PATH,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
        cacheDir: join(app.getPath('userData'), 'systemTasks'),
    }),
    emitEvent: (name, payload) => eventBus.emit(name, payload),
});

const desktopFiles = new ElectronDesktopFiles({
    pickFile: async ({ title, extensions }) => {
        const result = await dialog.showOpenDialog({
            title,
            properties: ['openFile'],
            filters: [{ name: 'Happier Personal Home backup', extensions: [...extensions] }],
        });
        return result.canceled ? null : result.filePaths[0] ?? null;
    },
    saveFile: async ({ title, defaultName, extensions }) => {
        const result = await dialog.showSaveDialog({
            title,
            defaultPath: defaultName,
            filters: [{ name: 'Happier Personal Home backup', extensions: [...extensions] }],
        });
        return result.canceled ? null : result.filePath ?? null;
    },
    openPath: (path) => shell.openPath(path),
    revealPath: (path) => shell.showItemInFolder(path),
});

const registry = createCommandRegistry({
    eventBus,
    quitLifecycle: {
        finishShutdown: (outcome) => quitLifecycle?.finishShutdown(outcome),
        rendererListening: (eventName) => quitLifecycle?.rendererListening(eventName),
    },
    showMainWindow: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return false;
        presentMainWindow(mainWindow);
        return true;
    },
    setWindowMode: (mode) => {
        windowMode = mode;
        console.log(`[window] mode ${windowMode}`);
    },
    autostart: createLoginItemWriter({
        api: app,
        platform: process.platform,
        isPackaged: app.isPackaged,
        development: isDevMode(),
    }),
    secureStorage: new ElectronSecureStorage({
        userDataPath: () => app.getPath('userData'),
        crypto: safeStorage,
    }),
    irohTunnel,
    systemTasks,
    desktopFiles,
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
        eventBus,
        preloadArguments: runtimeConfig === null ? [] : [encodeRuntimeConfigArgument(runtimeConfig)],
    });
    mainWindow = window;
    quitLifecycle?.attachWindow(window);

    window.on('closed', () => {
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

    quitLifecycle = new DesktopQuitLifecycle({
        app,
        eventBus,
        ensureMainWindow: async () => {
            await app.whenReady();
            if (!mainWindow || mainWindow.isDestroyed()) await openMainWindow();
        },
        showMainWindow: () => {
            if (mainWindow && !mainWindow.isDestroyed()) presentMainWindow(mainWindow);
        },
        shutdownForProcessExit: () => irohTunnel.shutdownForProcessExit(),
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
