import { transformFileSync } from '@babel/core';
import { fileURLToPath } from 'node:url';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import { createDesktopUpdaterStore, type DesktopUpdaterStore } from './desktopUpdater';
import { useDesktopUpdater } from './useDesktopUpdater';

type TauriInvoke = (command: string, args?: Record<string, unknown>) => unknown | Promise<unknown>;
type EventHandler = (event: { payload: unknown }) => void;

const UPDATE_CHECKS_ENV = 'EXPO_PUBLIC_HAPPIER_DESKTOP_UPDATES_ENABLED';
const originalUpdateChecksEnv = process.env[UPDATE_CHECKS_ENV];
const originalDevFlag = (globalThis as { __DEV__?: boolean }).__DEV__;
const HOUR_MS = 60 * 60 * 1000;

function createLocalStorage() {
    const map = new Map<string, string>();
    return {
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        setItem: (k: string, v: string) => void map.set(k, String(v)),
        removeItem: (k: string) => void map.delete(k),
        clear: () => void map.clear(),
    };
}

type Globals = Record<string, unknown>;
const globals = globalThis as unknown as Globals;

function clearDesktopGlobals() {
    for (const key of ['window', '__TAURI_INTERNALS__', '__TAURI__', 'localStorage']) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete globals[key];
    }
    if (originalDevFlag === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as { __DEV__?: boolean }).__DEV__;
    } else {
        (globalThis as { __DEV__?: boolean }).__DEV__ = originalDevFlag;
    }
}

/**
 * The Tauri IPC, its event channel and the window's focus event are the boundaries; the store
 * above them is real.
 */
function installDesktop(invoke: TauriInvoke | null) {
    const storage = createLocalStorage();
    const eventHandlers = new Map<string, EventHandler>();
    const windowListeners = new Map<string, () => void>();
    globals.localStorage = storage;
    if (!invoke) {
        globals.window = {};
        return { storage, eventHandlers, windowListeners };
    }
    const internals = { invoke };
    globals.__TAURI_INTERNALS__ = internals;
    globals.__TAURI__ = {
        event: {
            listen: async (name: string, handler: EventHandler) => {
                eventHandlers.set(name, handler);
                return () => eventHandlers.delete(name);
            },
        },
    };
    globals.window = {
        __TAURI_INTERNALS__: internals,
        addEventListener: (name: string, listener: () => void) => windowListeners.set(name, listener),
        removeEventListener: (name: string) => windowListeners.delete(name),
    };
    return { storage, eventHandlers, windowListeners };
}

function offer(version: string, extra: Partial<{ downloaded: boolean }> = {}) {
    return { version, currentVersion: '1.0.0', notes: null, pubDate: null, downloaded: false, ...extra };
}

async function settle() {
    await act(async () => {
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    await flushHookEffects();
}

describe('desktop app updater (one owner for every surface)', () => {
    let store: DesktopUpdaterStore;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-25T10:00:00Z'));
        process.env[UPDATE_CHECKS_ENV] = '1';
        clearDesktopGlobals();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
        clearDesktopGlobals();
        if (originalUpdateChecksEnv === undefined) delete process.env[UPDATE_CHECKS_ENV];
        else process.env[UPDATE_CHECKS_ENV] = originalUpdateChecksEnv;
    });

    it('statically inlines the desktop update override in a production Expo transform', () => {
        process.env[UPDATE_CHECKS_ENV] = '0';
        const originalBabelEnv = process.env.BABEL_ENV;
        process.env.BABEL_ENV = 'production';
        let transformed: ReturnType<typeof transformFileSync>;
        try {
            transformed = transformFileSync(fileURLToPath(new URL('./desktopUpdater.ts', import.meta.url)), {
                babelrc: false,
                configFile: false,
                caller: { name: 'metro' },
                presets: ['babel-preset-expo'],
            });
        } finally {
            if (originalBabelEnv === undefined) delete process.env.BABEL_ENV;
            else process.env.BABEL_ENV = originalBabelEnv;
        }

        expect(transformed?.code).toContain('parseOptionalBoolean("0")');
        expect(transformed?.code).not.toContain('process.env.EXPO_PUBLIC_HAPPIER_DESKTOP_UPDATES_ENABLED');
    });

    it('stays idle outside Tauri and in a source development bundle', async () => {
        installDesktop(null);
        store = createDesktopUpdaterStore();
        const web = await renderHook(() => useDesktopUpdater(store));
        expect(web.getCurrent()?.phase).toBe('idle');

        delete process.env[UPDATE_CHECKS_ENV];
        (globalThis as { __DEV__?: boolean }).__DEV__ = true;
        const invoke = vi.fn(async () => offer('9.9.9'));
        installDesktop(invoke);
        store = createDesktopUpdaterStore();
        const dev = await renderHook(() => useDesktopUpdater(store));
        await settle();
        expect(invoke).not.toHaveBeenCalled();
        expect(dev.getCurrent()?.phase).toBe('idle');
    });

    it('never checks from the pet overlay webview: the main window owns the one pending update', async () => {
        const invoke = vi.fn(async () => offer('1.2.0'));
        installDesktop(invoke);
        (globals.window as Record<string, unknown>).location = { href: 'tauri://localhost/desktop/pet-overlay' };
        store = createDesktopUpdaterStore();
        const hook = await renderHook(() => useDesktopUpdater(store));
        await settle();
        expect(invoke).not.toHaveBeenCalled();
        expect(hook.getCurrent()?.phase).toBe('idle');
    });

    it('checks once for every mounted surface, and all of them see the same answer (S-3)', async () => {
        const invoke = vi.fn(async (command: string) => {
            if (command === 'desktop_fetch_update') return offer('1.2.0');
            throw new Error(`unexpected ${command}`);
        });
        installDesktop(invoke);
        store = createDesktopUpdaterStore();

        const pill = await renderHook(() => useDesktopUpdater(store));
        const settingsRow = await renderHook(() => useDesktopUpdater(store));
        await settle();

        expect(invoke.mock.calls.filter(([command]) => command === 'desktop_fetch_update')).toHaveLength(1);
        expect(pill.getCurrent()?.phase).toBe('available');
        expect(settingsRow.getCurrent()?.version).toBe('1.2.0');

        act(() => store.skipVersion());
        expect(pill.getCurrent()?.skipped).toBe(true);
        expect(settingsRow.getCurrent()?.skipped).toBe(true);
    });

    it('downloads with a real percentage, rests at ready, and restarts only when asked', async () => {
        const invoke = vi.fn(async (command: string) => {
            if (command === 'desktop_fetch_update') return offer('1.2.0');
            if (command === 'desktop_download_update') {
                harness.eventHandlers.get('desktop_update_download_progress')?.({
                    payload: { version: '1.2.0', downloadedBytes: 40, totalBytes: 100 },
                });
                expect(store.getSnapshot()).toMatchObject({ phase: 'downloading', downloadPercent: 40 });
                return true;
            }
            if (command === 'desktop_install_update') return true;
            throw new Error(`unexpected ${command}`);
        });
        const harness = installDesktop(invoke);
        store = createDesktopUpdaterStore();
        const hook = await renderHook(() => useDesktopUpdater(store));
        await settle();

        await act(async () => { await store.download(); });
        expect(hook.getCurrent()).toMatchObject({ phase: 'ready', version: '1.2.0', downloadPercent: null });
        expect(invoke).not.toHaveBeenCalledWith('desktop_install_update', undefined);

        await act(async () => { await store.install(); });
        expect(invoke).toHaveBeenCalledWith('desktop_install_update', undefined);
        expect(hook.getCurrent()?.phase).toBe('installing');
    });

    it('names which step failed instead of carrying the raw error, and Retry repeats that step', async () => {
        let downloadAttempts = 0;
        const invoke = vi.fn(async (command: string) => {
            if (command === 'desktop_fetch_update') return offer('1.2.0');
            if (command === 'desktop_download_update') {
                downloadAttempts += 1;
                if (downloadAttempts === 1) throw new Error('error sending request for url (https://…)');
                return true;
            }
            throw new Error(`unexpected ${command}`);
        });
        installDesktop(invoke);
        store = createDesktopUpdaterStore();
        const hook = await renderHook(() => useDesktopUpdater(store));
        await settle();

        await act(async () => { await store.download(); });
        expect(hook.getCurrent()).toMatchObject({ phase: 'failed', failure: 'download', version: '1.2.0' });
        expect(JSON.stringify(hook.getCurrent())).not.toContain('error sending request');

        await act(async () => { await store.retry(); });
        expect(hook.getCurrent()?.phase).toBe('ready');
    });

    it('re-checks on focus only once the answer is due, backing off sooner after a failed check', async () => {
        let fail = true;
        const invoke = vi.fn(async (command: string) => {
            if (command !== 'desktop_fetch_update') throw new Error(`unexpected ${command}`);
            if (fail) throw new Error('offline');
            return null;
        });
        const harness = installDesktop(invoke);
        store = createDesktopUpdaterStore();
        const hook = await renderHook(() => useDesktopUpdater(store));
        await settle();
        expect(hook.getCurrent()).toMatchObject({ phase: 'failed', failure: 'check' });
        const checks = () => invoke.mock.calls.length;
        expect(checks()).toBe(1);

        act(() => { harness.windowListeners.get('focus')?.(); });
        await settle();
        expect(checks()).toBe(1);

        vi.setSystemTime(Date.now() + HOUR_MS);
        fail = false;
        act(() => { harness.windowListeners.get('focus')?.(); });
        await settle();
        expect(checks()).toBe(2);
        expect(hook.getCurrent()?.phase).toBe('upToDate');

        vi.setSystemTime(Date.now() + HOUR_MS);
        act(() => { harness.windowListeners.get('focus')?.(); });
        await settle();
        expect(checks()).toBe(2);

        vi.setSystemTime(Date.now() + 24 * HOUR_MS);
        act(() => { harness.windowListeners.get('focus')?.(); });
        await settle();
        expect(checks()).toBe(3);
    });

    it('keys a skipped version to the version offered, so a newer one is offered again', async () => {
        let version = '1.2.0';
        const invoke = vi.fn(async () => offer(version));
        const harness = installDesktop(invoke);
        store = createDesktopUpdaterStore();
        const hook = await renderHook(() => useDesktopUpdater(store));
        await settle();

        act(() => store.skipVersion());
        expect(hook.getCurrent()?.skipped).toBe(true);
        expect(harness.storage.getItem('desktop_update_dismissed_version')).toBe('1.2.0');

        version = '1.3.0';
        await act(async () => { await store.check({ force: true }); });
        expect(hook.getCurrent()).toMatchObject({ phase: 'available', version: '1.3.0', skipped: false });
    });

    it('resumes at ready when the offered version was already downloaded', async () => {
        installDesktop(vi.fn(async () => offer('1.2.0', { downloaded: true })));
        store = createDesktopUpdaterStore();
        const hook = await renderHook(() => useDesktopUpdater(store));
        await settle();
        expect(hook.getCurrent()?.phase).toBe('ready');
    });
});
