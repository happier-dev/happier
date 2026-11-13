import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { App, BrowserWindow, WebContents } from 'electron';

import { DesktopEventBus } from './ipc/eventBus';
import { DesktopQuitLifecycle } from './quitLifecycle';

function createHarness(options: Readonly<{
    rendererReady?: boolean;
    windowOpen?: boolean;
    senderDestroyed?: boolean;
    shutdownForProcessExit?: () => Promise<void>;
}> = {}) {
    // Electron's app/window/WebContents are the OS/process boundary; lifecycle logic stays real.
    const app = new EventEmitter();
    let quitCalls = 0;
    const exitCodes: number[] = [];
    const electronApp = Object.assign(app, {
        quit: () => { quitCalls += 1; },
        exit: (code: number) => { exitCodes.push(code); },
    }) as unknown as Pick<App, 'on' | 'quit' | 'exit'>;
    const window = new EventEmitter();
    let windowDestroyed = false;
    const messages: unknown[] = [];
    const sender = {
        isDestroyed: () => options.senderDestroyed === true,
        send: (_channel: string, message: unknown) => messages.push(message),
    } as unknown as WebContents;
    const electronWindow = Object.defineProperty(window, 'webContents', {
        get: () => {
            if (windowDestroyed) throw new TypeError('Object has been destroyed');
            return sender;
        },
    }) as unknown as BrowserWindow;
    const eventBus = new DesktopEventBus();
    if (options.rendererReady !== false) eventBus.listen('desktop_app_exit_requested', 11, sender);
    let openCount = 0;
    let showCount = 0;
    let shutdownCount = 0;
    const lifecycle = new DesktopQuitLifecycle({
        app: electronApp,
        eventBus,
        ensureMainWindow: async () => { openCount += 1; },
        showMainWindow: () => { showCount += 1; },
        shutdownForProcessExit: async () => {
            shutdownCount += 1;
            await options.shutdownForProcessExit?.();
        },
    });
    if (options.windowOpen !== false) lifecycle.attachWindow(electronWindow);
    const emit = (emitter: EventEmitter, name: string) => {
        let prevented = false;
        if (emitter === window && name === 'closed') windowDestroyed = true;
        emitter.emit(name, { preventDefault: () => { prevented = true; } });
        return prevented;
    };
    return {
        app, window, sender, eventBus, lifecycle, messages, emit,
        readState: () => ({ quitCalls, exitCodes, openCount, showCount, shutdownCount }),
    };
}

test('application Quit waits for one renderer handoff and repeated Quit cannot bypass it', async () => {
    const host = createHarness();
    assert.equal(host.emit(host.app, 'before-quit'), true);
    assert.equal(host.emit(host.app, 'before-quit'), true);
    await Promise.resolve();
    assert.deepEqual(host.messages, [{
        callbackId: 11,
        payload: { event: 'desktop_app_exit_requested', id: 11, payload: { stopServices: false, menuBarSupported: false } },
        once: false,
    }]);
    assert.equal(host.readState().quitCalls, 0);
    assert.equal(host.readState().shutdownCount, 0);
    assert.deepEqual(host.readState().exitCodes, []);
});

test('ordinary window close retains the renderer until the shared quit owner answers', async () => {
    const host = createHarness();
    assert.equal(host.emit(host.window, 'close'), true);
    await Promise.resolve();
    assert.equal(host.messages.length, 1);
    assert.equal(host.eventBus.listenerCount('desktop_app_exit_requested'), 1);
    assert.equal(host.readState().quitCalls, 0);
});

test('Quit with no renderer opens the existing main-window path and waits for its listener', async () => {
    const host = createHarness({ rendererReady: false, windowOpen: false });
    host.app.emit('window-all-closed');
    await Promise.resolve();
    assert.equal(host.readState().openCount, 1);
    assert.deepEqual(host.messages, []);
    assert.equal(host.readState().quitCalls, 0);
    host.eventBus.listen('desktop_app_exit_requested', 11, host.sender);
    host.lifecycle.rendererListening('desktop_app_exit_requested');
    host.lifecycle.rendererListening('desktop_app_exit_requested');
    assert.equal(host.messages.length, 1);
});

test('a keep-window outcome cancels Quit and permits a fresh request', async () => {
    const host = createHarness();
    host.emit(host.window, 'close');
    await Promise.resolve();
    host.lifecycle.finishShutdown('menuBar');
    assert.equal(host.readState().showCount, 1);
    assert.equal(host.readState().quitCalls, 0);
    assert.equal(host.readState().shutdownCount, 0);
    assert.equal(host.emit(host.app, 'before-quit'), true);
    await Promise.resolve();
    assert.equal(host.messages.length, 2);
});

test('an accepted exit releases close/quit interception and settles Iroh before final process exit', async () => {
    const host = createHarness();
    host.emit(host.app, 'before-quit');
    await Promise.resolve();
    host.lifecycle.finishShutdown();
    assert.equal(host.readState().quitCalls, 1);
    assert.equal(host.emit(host.app, 'before-quit'), false);
    assert.equal(host.emit(host.window, 'close'), false);
    assert.doesNotThrow(() => host.emit(host.window, 'closed'));
    assert.equal(host.eventBus.listenerCount('desktop_app_exit_requested'), 0);
    assert.equal(host.emit(host.app, 'will-quit'), true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(host.readState().shutdownCount, 1);
    assert.deepEqual(host.readState().exitCodes, [0]);
    assert.equal(host.readState().quitCalls, 1);
    host.app.emit('window-all-closed');
    assert.equal(host.readState().quitCalls, 1);
    assert.equal(host.messages.length, 1);
});

test('a destroyed renderer listener cannot consume a pending quit request', async () => {
    const host = createHarness({ senderDestroyed: true });
    host.emit(host.app, 'before-quit');
    await Promise.resolve();
    const messages: unknown[] = [];
    const liveSender = {
        isDestroyed: () => false,
        send: (_channel: string, message: unknown) => messages.push(message),
    } as unknown as WebContents;
    host.eventBus.listen('desktop_app_exit_requested', 12, liveSender);
    host.lifecycle.rendererListening('desktop_app_exit_requested');
    assert.equal(messages.length, 1);
    assert.equal(host.readState().quitCalls, 0);
});

test('repeated Quit cannot bypass an in-flight final Iroh shutdown', async () => {
    let finishIroh!: () => void;
    const shutdown = new Promise<void>((resolve) => { finishIroh = resolve; });
    const host = createHarness({ shutdownForProcessExit: () => shutdown });
    host.emit(host.app, 'before-quit');
    await Promise.resolve();
    host.lifecycle.finishShutdown();
    assert.equal(host.emit(host.app, 'will-quit'), true);
    assert.equal(host.emit(host.app, 'will-quit'), true);
    assert.equal(host.readState().shutdownCount, 1);
    assert.deepEqual(host.readState().exitCodes, []);
    finishIroh();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(host.readState().exitCodes, [0]);
    assert.equal(host.readState().quitCalls, 1);
});
