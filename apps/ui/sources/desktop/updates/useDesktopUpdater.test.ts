import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import { useDesktopUpdater } from './useDesktopUpdater';

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

async function renderDesktopUpdaterHook(options: {
    storage: DesktopStorage;
    invokeMock?: TauriInvoke;
    isDesktop: boolean;
}) {
    setDesktopGlobals(options);
    return renderHook(() => useDesktopUpdater());
}

describe('useDesktopUpdater (hook)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearDesktopGlobals();
    });

    afterEach(() => {
        standardCleanup();
        clearDesktopGlobals();
    });

    it('stays idle when not running in Tauri', async () => {
        const storage = createLocalStorage();
        const hook = await renderDesktopUpdaterHook({
            storage,
            isDesktop: false,
        });

        const latest = hook.getCurrent();
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
        const hook = await renderDesktopUpdaterHook({
            storage,
            invokeMock,
            isDesktop: true,
        });

        const latest = hook.getCurrent();
        expect(invokeMock).toHaveBeenCalledTimes(1);
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
        const hook = await renderDesktopUpdaterHook({
            storage,
            invokeMock,
            isDesktop: true,
        });

        expect(hook.getCurrent()?.status).toBe('available');
        act(() => {
            hook.getCurrent()?.dismiss();
        });
        expect(hook.getCurrent()?.status).toBe('dismissed');
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
        const hook = await renderDesktopUpdaterHook({
            storage,
            invokeMock,
            isDesktop: true,
        });

        expect(hook.getCurrent()?.status).toBe('available');

        await act(async () => {
            await hook.getCurrent()?.startInstall();
        });
        await flushHookEffects();

        const latest = hook.getCurrent();
        expect(invokeMock).toHaveBeenCalledWith('desktop_install_update', undefined);
        expect(latest?.status).toBe('upToDate');
        expect(latest?.availableVersion).toBe(null);
    });
});
