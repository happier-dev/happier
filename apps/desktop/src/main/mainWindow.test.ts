import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import { test } from 'node:test';
import type { BrowserWindowConstructorOptions, WebContents } from 'electron';

import { BRIDGE_CHANNELS } from '../shared/bridge';
import { DesktopEventBus } from './ipc/eventBus';
import { DesktopWindowChrome } from './windowChrome';
import { createHarness } from './commands/registry.testkit';
import { runCommand } from './commands/registry';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

function createWindowChrome(platform: NodeJS.Platform) {
    const userData = mkdtempSync(join(tmpdir(), 'happier-window-chrome-'));
    after(() => rmSync(userData, { recursive: true, force: true }));
    return new DesktopWindowChrome({ platform, userDataPath: () => userData });
}

// Electron is the native boundary. Keep real window construction and event transport beneath it.
class NativeWindow extends EventEmitter {
    constructor(readonly options: BrowserWindowConstructorOptions) { super(); }

    maximized = false;
    fullscreen = false;
    webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler: (handler: (details: { url: string }) => { action: string }) => {
            this.openWindow = handler;
        },
    });
    openWindow?: (details: { url: string }) => { action: string };

    isMaximized(): boolean { return this.maximized; }
    isFullScreen(): boolean { return this.fullscreen; }
}

const electronModuleId = require.resolve('electron');
const externalUrls: string[] = [];
const previousElectronModule = require.cache[electronModuleId];
const electronBoundary = new Module(electronModuleId);
electronBoundary.exports = { BrowserWindow: NativeWindow, shell: { openExternal: async (url: string) => { externalUrls.push(url); } } };
require.cache[electronModuleId] = electronBoundary;
const { createMainWindow } = require('./mainWindow') as typeof import('./mainWindow');
if (previousElectronModule) {
    require.cache[electronModuleId] = previousElectronModule;
} else {
    delete require.cache[electronModuleId];
}

test('the selected renderer origin is the only navigation target and new windows open safe web links externally', async () => {
    for (const rendererUrl of ['happier://localhost/', 'http://localhost:8081']) {
        const window = createMainWindow({
            windowChrome: createWindowChrome('linux'), eventBus: new DesktopEventBus(), rendererUrl,
        }) as unknown as NativeWindow;
        for (const eventName of ['will-navigate', 'will-redirect']) {
            for (const [url, denied] of [
                [`${rendererUrl.replace(/\/$/, '')}/session/owned`, false],
                ['https://attacker.example/', true],
                ['happier://attacker.example/', true],
                ['http://localhost:8082/', true],
                [rendererUrl.startsWith('http:') ? 'happier://localhost/' : 'http://localhost:8081/', true],
                ['file:///tmp/remote.html', true],
                ['data:text/html,remote', true],
            ] as const) {
                let prevented = false;
                window.webContents.emit(eventName, { url, isMainFrame: true, preventDefault: () => { prevented = true; } }, url);
                assert.equal(prevented, denied, `${eventName}: ${url}`);
            }
        }
        let subframeRedirectPrevented = false;
        window.webContents.emit('will-redirect', {
            url: 'https://external-guest.example/redirect', isMainFrame: false,
            preventDefault: () => { subframeRedirectPrevented = true; },
        }, 'https://external-guest.example/redirect');
        assert.equal(subframeRedirectPrevented, false, 'guest frames have no privileged IPC and retain their navigation');
        assert.ok(window.openWindow, 'window creation must be denied at the native boundary');
        const before = externalUrls.length;
        for (const url of ['https://example.com/docs', 'http://example.com/docs', 'file:///tmp/remote.html', 'javascript:alert(1)', 'happier://localhost/', 'https://user:secret@example.com/', 'invalid']) {
            assert.deepEqual(window.openWindow({ url }), { action: 'deny' });
        }
        assert.deepEqual(externalUrls.slice(before), ['https://example.com/docs', 'http://example.com/docs']);
    }
});

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
    const options = { windowChrome: createWindowChrome('win32'), eventBus };
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

for (const platform of ['win32', 'linux'] as const) {
    test(`${platform} starts with integrated controls and no competing native frame`, () => {
        const window = createMainWindow({ windowChrome: createWindowChrome(platform), eventBus: new DesktopEventBus() }) as unknown as NativeWindow;
        assert.equal(window.options.frame, false);
    });
}


test('Windows persistence controls the next native window while the current frame remains authoritative', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'happier-window-chrome-restart-'));
    after(() => rmSync(userData, { recursive: true, force: true }));
    const windowChrome = new DesktopWindowChrome({ platform: 'win32', userDataPath: () => userData });
    const { registry, context } = createHarness({ windowChrome });
    const current = createMainWindow({ windowChrome, eventBus: new DesktopEventBus() }) as unknown as NativeWindow;
    assert.equal(current.options.frame, false);
    assert.deepEqual(await runCommand(registry, 'desktop_set_native_title_bar', { useNativeTitleBar: true }, context), {
        kind: 'implemented', value: {
            strategy: 'custom-controls', canSetNativeTitleBar: true,
            useNativeTitleBar: true, nativeTitleBarRestartRequired: true,
        },
    });
    assert.equal(current.options.frame, false);
    assert.deepEqual(JSON.parse(readFileSync(join(userData, 'window-chrome.json'), 'utf8')), { useNativeTitleBar: true });

    const restarted = new DesktopWindowChrome({ platform: 'win32', userDataPath: () => userData });
    const next = createMainWindow({ windowChrome: restarted, eventBus: new DesktopEventBus() }) as unknown as NativeWindow;
    assert.equal(next.options.frame, true);
    const nextRegistry = createHarness({ windowChrome: restarted });
    assert.deepEqual(await runCommand(nextRegistry.registry, 'desktop_get_window_chrome_policy', {}, nextRegistry.context), {
        kind: 'implemented', value: {
            strategy: 'native-windows-frame', canSetNativeTitleBar: true,
            useNativeTitleBar: true, nativeTitleBarRestartRequired: false,
        },
    });
    assert.deepEqual(await runCommand(nextRegistry.registry, 'desktop_set_native_title_bar', { useNativeTitleBar: false }, nextRegistry.context), {
        kind: 'implemented', value: {
            strategy: 'native-windows-frame', canSetNativeTitleBar: true,
            useNativeTitleBar: false, nativeTitleBarRestartRequired: true,
        },
    });
    // Choosing the current frame again cancels a pending restart without recreating this window.
    await runCommand(nextRegistry.registry, 'desktop_set_native_title_bar', { useNativeTitleBar: true }, nextRegistry.context);
    assert.equal(restarted.readPolicy().nativeTitleBarRestartRequired, false);
    assert.equal(next.options.frame, true);
});

test('a failed Windows preference write retains the saved choice, is visible, and can be retried', async (t) => {
    const userData = mkdtempSync(join(tmpdir(), 'happier-window-chrome-retry-'));
    after(() => rmSync(userData, { recursive: true, force: true }));
    const windowChrome = new DesktopWindowChrome({ platform: 'win32', userDataPath: () => userData });
    const { registry, context } = createHarness({ windowChrome });
    const window = createMainWindow({ windowChrome, eventBus: new DesktopEventBus() }) as unknown as NativeWindow;
    const warnings: unknown[][] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
    const destination = join(userData, 'window-chrome.json');
    mkdirSync(destination);
    const failed = await runCommand(registry, 'desktop_set_native_title_bar', { useNativeTitleBar: true }, context);
    assert.deepEqual(failed, {
        kind: 'implemented', value: {
            strategy: 'custom-controls', canSetNativeTitleBar: true,
            useNativeTitleBar: false, nativeTitleBarRestartRequired: false,
            nativeTitleBarPersistenceError: true,
        },
    });
    assert.match(String(warnings[0]?.[0]), /preference_write_failed/);
    rmSync(destination, { recursive: true });
    await runCommand(registry, 'desktop_set_native_title_bar', { useNativeTitleBar: true }, context);
    assert.equal(windowChrome.readPolicy().useNativeTitleBar, true);
    assert.equal(windowChrome.readPolicy().nativeTitleBarPersistenceError, undefined);
    assert.equal(window.options.frame, false);
});

test('malformed persisted Windows preference uses integrated controls and reports its read failure', (t) => {
    const userData = mkdtempSync(join(tmpdir(), 'happier-window-chrome-invalid-'));
    after(() => rmSync(userData, { recursive: true, force: true }));
    writeFileSync(join(userData, 'window-chrome.json'), '{"useNativeTitleBar":"true"}');
    const warnings: unknown[][] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
    const windowChrome = new DesktopWindowChrome({ platform: 'win32', userDataPath: () => userData });
    const window = createMainWindow({ windowChrome, eventBus: new DesktopEventBus() }) as unknown as NativeWindow;
    assert.equal(window.options.frame, false);
    assert.equal(windowChrome.readPolicy().nativeTitleBarPersistenceError, true);
    assert.match(String(warnings[0]?.[0]), /preference_read_failed/);
});

test('macOS retains hiddenInset traffic lights and Linux cannot write a Windows frame preference', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
        const windowChrome = createWindowChrome(platform);
        const window = createMainWindow({ windowChrome, eventBus: new DesktopEventBus() }) as unknown as NativeWindow;
        assert.equal(window.options.frame, platform === 'darwin');
        assert.equal(window.options.titleBarStyle, platform === 'darwin' ? 'hiddenInset' : undefined);
        assert.deepEqual(windowChrome.readPolicy(), {
            strategy: platform === 'darwin' ? 'native-macos-traffic-lights' : 'custom-controls',
        });
        const { registry, context } = createHarness({ windowChrome });
        await assert.rejects(runCommand(registry, 'desktop_set_native_title_bar', { useNativeTitleBar: true }, context), /only on Windows/);
    }
});
