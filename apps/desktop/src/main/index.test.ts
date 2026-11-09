import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { IpcMainInvokeEvent } from 'electron';
import { BRIDGE_CHANNELS, type BridgeInvokeRequest } from '../shared/bridge';

test('the composed IPC entry admits only the owning main frame at the selected renderer origin', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'happier-desktop-admission-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let versionReads = 0;
    const invokeLogs: unknown[][] = [];
    t.mock.method(console, 'log', (...args: unknown[]) => {
        if (String(args[0]).startsWith('[invoke]')) invokeLogs.push(args);
    });
    const app = Object.assign(new EventEmitter(), {
        getPath: () => directory,
        getAppPath: () => directory,
        getVersion: () => { versionReads += 1; return 'owner-version'; },
        requestSingleInstanceLock: () => true,
        whenReady: () => Promise.resolve(),
        isPackaged: false,
    });
    const windows: NativeWindow[] = [];
    class NativeWindow extends EventEmitter {
        webContents = Object.assign(new EventEmitter(), {
            mainFrame: { url: '' }, isDestroyed: () => false,
            setWindowOpenHandler: () => {},
        });
        constructor() { super(); windows.push(this); }
        isDestroyed() { return false; }
        async loadURL(url: string) { this.webContents.mainFrame.url = url; }
        static fromWebContents(sender: unknown) { return windows.find((window) => window.webContents === sender); }
    }
    let invoke: ((event: IpcMainInvokeEvent, request: BridgeInvokeRequest) => Promise<unknown>) | undefined;
    // Electron's native application/window/IPC API is the only stub; registry and admission stay real.
    const moduleId = require.resolve('electron');
    const previous = require.cache[moduleId];
    const boundary = new Module(moduleId);
    boundary.exports = {
        app, BrowserWindow: NativeWindow, dialog: {}, safeStorage: {}, shell: {},
        protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
        ipcMain: { handle: (channel: string, handler: typeof invoke) => {
            assert.equal(channel, BRIDGE_CHANNELS.invoke); invoke = handler;
        } },
    };
    require.cache[moduleId] = boundary;
    t.after(() => { if (previous) require.cache[moduleId] = previous; else delete require.cache[moduleId]; });
    require('./index');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(invoke);
    const owner = windows[0];
    assert.ok(owner);
    const invokeAs = (sender: unknown, senderFrame: unknown) => invoke!({ sender, senderFrame } as IpcMainInvokeEvent, { command: 'plugin:app|version', args: {} });
    assert.equal(await invokeAs(owner.webContents, owner.webContents.mainFrame), 'owner-version');
    const admittedUrl = owner.webContents.mainFrame.url;
    const inactiveOrigin = admittedUrl.startsWith('http:') ? 'happier://localhost/' : 'http://localhost:8081/';
    for (const url of ['https://attacker.example/', 'happier://attacker.example/', 'file:///tmp/page.html', 'http://localhost:8082/', inactiveOrigin]) {
        owner.webContents.mainFrame.url = url;
        await assert.rejects(invokeAs(owner.webContents, owner.webContents.mainFrame), /untrusted renderer/i);
    }
    owner.webContents.mainFrame.url = admittedUrl;
    await assert.rejects(invokeAs(owner.webContents, { url: admittedUrl }), /untrusted renderer/i);
    await assert.rejects(invokeAs(owner.webContents, null), /untrusted renderer/i);
    const other = new NativeWindow();
    other.webContents.mainFrame.url = admittedUrl;
    await assert.rejects(invokeAs(other.webContents, other.webContents.mainFrame), /untrusted renderer/i);
    assert.equal(versionReads, 1, 'denied calls never dispatch privileged commands');
    owner.webContents.mainFrame.url = `${admittedUrl.replace(/\/$/, '')}/session/owner`;
    assert.equal(await invokeAs(owner.webContents, owner.webContents.mainFrame), 'owner-version');
    assert.equal(invokeLogs.length, 0, 'ordinary IPC dispatch does not perform evaluation logging');
});
