import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import { test } from 'node:test';
import type { WebContents } from 'electron';

import { BRIDGE_CHANNELS } from '../shared/bridge';
import { DesktopEventBus } from './ipc/eventBus';

// Electron is the native boundary. Keep real window construction and event transport beneath it.
class NativeWindow extends EventEmitter {
    maximized = false;
    fullscreen = false;

    isMaximized(): boolean { return this.maximized; }
    isFullScreen(): boolean { return this.fullscreen; }
}

const electronModuleId = require.resolve('electron');
const previousElectronModule = require.cache[electronModuleId];
const electronBoundary = new Module(electronModuleId);
electronBoundary.exports = { BrowserWindow: NativeWindow };
require.cache[electronModuleId] = electronBoundary;
const { createMainWindow } = require('./mainWindow') as typeof import('./mainWindow');
if (previousElectronModule) {
    require.cache[electronModuleId] = previousElectronModule;
} else {
    delete require.cache[electronModuleId];
}

test('native window changes publish actual maximize and fullscreen state through the renderer event bus', () => {
    const messages: unknown[] = [];
    const sender = {
        isDestroyed: () => false,
        send: (channel: string, message: unknown) => {
            assert.equal(channel, BRIDGE_CHANNELS.callback);
            messages.push(message);
        },
    } as unknown as WebContents;
    const eventBus = new DesktopEventBus();
    eventBus.listen('desktopWindow://state', 17, sender);
    const options = { platform: 'win32' as const, eventBus };
    const window = createMainWindow(options) as unknown as NativeWindow;

    window.maximized = true;
    window.emit('maximize');
    window.maximized = false;
    window.emit('unmaximize');
    window.fullscreen = true;
    window.emit('enter-full-screen');
    window.fullscreen = false;
    window.emit('leave-full-screen');
    window.maximized = true;
    window.fullscreen = true;
    window.emit('enter-full-screen');

    assert.deepEqual(messages, [
        { isMaximized: true, isFullscreen: false },
        { isMaximized: false, isFullscreen: false },
        { isMaximized: false, isFullscreen: true },
        { isMaximized: false, isFullscreen: false },
        { isMaximized: true, isFullscreen: true },
    ].map((payload) => ({
        callbackId: 17,
        payload: { event: 'desktopWindow://state', id: 17, payload },
        once: false,
    })));

    eventBus.unlisten(17);
    window.maximized = false;
    window.emit('unmaximize');
    assert.equal(messages.length, 5);
});
