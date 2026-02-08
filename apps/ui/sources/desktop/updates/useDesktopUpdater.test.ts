import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type DesktopUpdaterSnapshot = {
    status: 'idle' | 'checking' | 'available' | 'installing' | 'error' | 'dismissed' | 'upToDate';
    availableVersion: string | null;
    error: string | null;
    dismiss: () => void;
    refresh: () => Promise<void>;
    startInstall: () => Promise<void>;
};

type DesktopStorage = ReturnType<typeof createLocalStorage>;
type TauriInvoke = (command: string, args?: Record<string, unknown>) => unknown | Promise<unknown>;

function createLocalStorage() {
    const map = new Map<string, string>();
    return {
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        setItem: (k: string, v: string) => void map.set(k, String(v)),
        removeItem: (k: string) => void map.delete(k),
        clear: () => void map.clear(),
    };
}

function clearDesktopGlobals() {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as any).window;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as any).__TAURI_INTERNALS__;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as any).localStorage;
}

function setDesktopGlobals(options: {
    storage: DesktopStorage;
    invokeMock?: TauriInvoke;
    isDesktop: boolean;
}) {
    (globalThis as any).localStorage = options.storage;
    if (!options.isDesktop) {
        (globalThis as any).window = {};
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).__TAURI_INTERNALS__;
        return;
    }

    const internals = options.invokeMock ? { invoke: options.invokeMock } : {};
    (globalThis as any).window = { __TAURI_INTERNALS__: internals };
    (globalThis as any).__TAURI_INTERNALS__ = internals;
}

async function flushAsyncTurns(turns = 3) {
    for (let index = 0; index < turns; index += 1) {
        await Promise.resolve();
    }
}

async function mockWebPlatform() {
    vi.doMock('react-native', async () => {
        const actual = await vi.importActual<any>('react-native');
        return {
            ...actual,
            Platform: { OS: 'web', select: (x: any) => x?.default },
        };
    });
}

async function renderDesktopUpdaterHook(options: {
    storage: DesktopStorage;
    invokeMock?: TauriInvoke;
    isDesktop: boolean;
}) {
    await mockWebPlatform();
    const { useDesktopUpdater } = await import('./useDesktopUpdater');

    let latest: DesktopUpdaterSnapshot | null = null;
    function Test() {
        latest = useDesktopUpdater();
        return React.createElement('View');
    }

    await act(async () => {
        setDesktopGlobals(options);
        renderer.create(React.createElement(Test));
        await flushAsyncTurns();
    });

    return {
        getLatest: () => latest,
    };
}

describe('useDesktopUpdater (hook)', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.unmock('react-native');
        vi.unmock('@tauri-apps/api/core');
        clearDesktopGlobals();
    });

    afterEach(() => {
        clearDesktopGlobals();
    });

    it('stays idle when not running in Tauri', async () => {
        const storage = createLocalStorage();
        const { getLatest } = await renderDesktopUpdaterHook({
            storage,
            isDesktop: false,
        });

        const latest = getLatest();
        expect(latest?.status).toBe('idle');
        expect(latest?.availableVersion).toBe(null);
    });

    it('exposes an available update when updater returns metadata', async () => {
        const invokeMock = vi.fn(async (cmd: string) => {
            if (cmd === 'desktop_fetch_update') {
                return {
                    version: '9.9.9',
                    currentVersion: '9.9.8',
                    notes: null,
                    pubDate: null,
                };
            }
            throw new Error(`unexpected command: ${cmd}`);
        });

        const storage = createLocalStorage();
        const { getLatest } = await renderDesktopUpdaterHook({
            storage,
            invokeMock,
            isDesktop: true,
        });

        await act(async () => {
            setDesktopGlobals({ storage, invokeMock, isDesktop: true });
            await getLatest()?.refresh();
            await flushAsyncTurns();
        });

        const latest = getLatest();
        expect(invokeMock).toHaveBeenCalledWith('desktop_fetch_update', undefined);
        expect(latest?.status).toBe('available');
        expect(latest?.availableVersion).toBe('9.9.9');
    });

    it('persists dismissal until available version changes', async () => {
        const invokeMock = vi.fn(async () => {
            return {
                version: '1.0.1',
                currentVersion: '1.0.0',
                notes: null,
                pubDate: null,
            };
        });

        const storage = createLocalStorage();
        const { getLatest } = await renderDesktopUpdaterHook({
            storage,
            invokeMock,
            isDesktop: true,
        });

        await act(async () => {
            setDesktopGlobals({ storage, invokeMock, isDesktop: true });
            await getLatest()?.refresh();
            await flushAsyncTurns();
        });

        expect(getLatest()?.status).toBe('available');
        act(() => {
            getLatest()?.dismiss();
        });
        expect(storage.getItem('desktop_update_dismissed_version')).toBe('1.0.1');
    });

    it('returns to up-to-date when install command reports no pending update', async () => {
        const invokeMock = vi.fn(async (cmd: string) => {
            if (cmd === 'desktop_fetch_update') {
                return {
                    version: '1.0.2',
                    currentVersion: '1.0.1',
                    notes: null,
                    pubDate: null,
                };
            }
            if (cmd === 'desktop_install_update') {
                return false;
            }
            throw new Error(`unexpected command: ${cmd}`);
        });

        const storage = createLocalStorage();
        const { getLatest } = await renderDesktopUpdaterHook({
            storage,
            invokeMock,
            isDesktop: true,
        });

        await act(async () => {
            setDesktopGlobals({ storage, invokeMock, isDesktop: true });
            await getLatest()?.refresh();
            await flushAsyncTurns();
        });
        expect(getLatest()?.status).toBe('available');

        await act(async () => {
            await getLatest()?.startInstall();
            await flushAsyncTurns();
        });

        const latest = getLatest();
        expect(invokeMock).toHaveBeenCalledWith('desktop_install_update', undefined);
        expect(latest?.status).toBe('upToDate');
        expect(latest?.availableVersion).toBe(null);
    });
});
