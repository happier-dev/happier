import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { desktopHostKind, invokeDesktopHost, isDesktopHost, listenDesktopHostEvent } from './desktopHost';

const coreInvokeSpy = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => null));
const listenSpy = vi.hoisted(() =>
    vi.fn(async (_event: string, _handler: (event: { payload: unknown }) => void) => () => {}),
);

// `@tauri-apps/api/*` is a third-party package that talks to the host over the bridge globals; it
// is the one genuine boundary this module reaches past the globals themselves.
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => coreInvokeSpy(...args),
}));
vi.mock('@tauri-apps/api/event', () => ({
    listen: (event: string, handler: (event: { payload: unknown }) => void) => listenSpy(event, handler),
}));

const TAURI_INTERNALS_KEY = '__TAURI_INTERNALS__';
const TAURI_KEY = '__TAURI__';

const ELECTRON_USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)'
    + ' happier-desktop/0.2.10 Chrome/150.0.0.0 Electron/43.4.0 Safari/537.36';
const BROWSER_USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)'
    + ' Chrome/150.0.0.0 Safari/537.36';

function writeGlobal(key: string, value: unknown) {
    if (value === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any)[key];
        return;
    }
    (globalThis as any)[key] = value;
}

describe('utils/platform/desktopHost', () => {
    const originalInternals = (globalThis as any)[TAURI_INTERNALS_KEY];
    const originalTauriApi = (globalThis as any)[TAURI_KEY];
    const originalNavigator = (globalThis as any).navigator;

    beforeEach(() => {
        coreInvokeSpy.mockClear();
        listenSpy.mockClear();
        writeGlobal(TAURI_INTERNALS_KEY, undefined);
        writeGlobal(TAURI_KEY, undefined);
        writeGlobal('isTauri', undefined);
        writeGlobal('navigator', { userAgent: BROWSER_USER_AGENT });
    });

    afterEach(() => {
        writeGlobal(TAURI_INTERNALS_KEY, originalInternals);
        writeGlobal(TAURI_KEY, originalTauriApi);
        writeGlobal('isTauri', undefined);
        writeGlobal('navigator', originalNavigator);
    });

    describe('desktopHostKind', () => {
        it('reports no desktop host in a plain browser runtime', () => {
            expect(desktopHostKind()).toBe(null);
            expect(isDesktopHost()).toBe(false);
        });

        it('reports no desktop host when the bridge global exists without invoke()', () => {
            writeGlobal(TAURI_INTERNALS_KEY, {});
            expect(desktopHostKind()).toBe(null);
            expect(isDesktopHost()).toBe(false);
        });

        it('reports the Tauri host when the bridge global exposes invoke()', () => {
            writeGlobal(TAURI_INTERNALS_KEY, { invoke: () => null });
            expect(desktopHostKind()).toBe('tauri');
            expect(isDesktopHost()).toBe(true);
        });

        it('reports the Tauri host when only the v2 core API exposes invoke()', () => {
            writeGlobal(TAURI_INTERNALS_KEY, { plugins: {} });
            writeGlobal(TAURI_KEY, { core: { invoke: () => null } });
            expect(desktopHostKind()).toBe('tauri');
        });

        it('reports the Tauri host from the v2 identity flag alone', () => {
            writeGlobal('isTauri', true);
            expect(desktopHostKind()).toBe('tauri');
        });

        it('reports the Tauri host from the WebView user agent before the bridge is installed', () => {
            writeGlobal('navigator', { userAgent: 'Mozilla/5.0 (Tauri)' });
            expect(desktopHostKind()).toBe('tauri');
            expect(isDesktopHost()).toBe(true);
        });

        it('reports the Electron host even though its preload installs a Tauri-shaped bridge', () => {
            writeGlobal('navigator', { userAgent: ELECTRON_USER_AGENT });
            writeGlobal(TAURI_INTERNALS_KEY, { invoke: () => null });
            expect(desktopHostKind()).toBe('electron');
            expect(isDesktopHost()).toBe(true);
        });

        it('reports the Electron host before its preload bridge is readable', () => {
            writeGlobal('navigator', { userAgent: ELECTRON_USER_AGENT });
            expect(desktopHostKind()).toBe('electron');
            expect(isDesktopHost()).toBe(true);
        });
    });

    describe('invokeDesktopHost', () => {
        it('routes the command and args through the host bridge of either shell', async () => {
            const invoke = vi.fn(async () => ({ ok: true }));
            writeGlobal(TAURI_INTERNALS_KEY, { invoke });

            await expect(
                invokeDesktopHost<{ ok: boolean }>('desktop_set_window_mode', { mode: 'main' }),
            ).resolves.toEqual({ ok: true });

            expect(invoke).toHaveBeenCalledWith('desktop_set_window_mode', { mode: 'main' });
            expect(coreInvokeSpy).not.toHaveBeenCalled();
        });

        it('falls back to the Tauri core API only when no bridge global is installed', async () => {
            coreInvokeSpy.mockResolvedValueOnce('from-core' as never);

            await expect(invokeDesktopHost<string>('desktop_show_main_window')).resolves.toBe('from-core');
            expect(coreInvokeSpy).toHaveBeenCalledWith('desktop_show_main_window', undefined);
        });
    });

    describe('listenDesktopHostEvent', () => {
        it('delivers event payloads to the handler and unsubscribes through the host', async () => {
            const unlisten = vi.fn();
            const hostHandlers: ((event: { payload: unknown }) => void)[] = [];
            listenSpy.mockImplementationOnce(async (_event, handler) => {
                hostHandlers.push(handler);
                return unlisten;
            });
            const handler = vi.fn();

            const unsubscribe = await listenDesktopHostEvent<{ value: number }>('desktop://window-state', handler);

            expect(listenSpy).toHaveBeenCalledWith('desktop://window-state', expect.any(Function));
            expect(hostHandlers).toHaveLength(1);
            hostHandlers[0]?.({ payload: { value: 7 } });
            expect(handler).toHaveBeenCalledWith({ value: 7 });

            unsubscribe();
            expect(unlisten).toHaveBeenCalledTimes(1);
        });
    });

    describe('role availability', () => {
        it.each(['browser', 'electron'])('settles %s without native acquisition or overlay subscriptions', async (kind) => {
            vi.resetModules();
            const invoke = vi.fn();
            if (kind === 'electron') {
                writeGlobal('navigator', { userAgent: ELECTRON_USER_AGENT });
                writeGlobal(TAURI_INTERNALS_KEY, { invoke });
            }
            const host = await import('./desktopHost');
            const availability = await host.getDesktopHostAvailability();
            for (const role of ['activity', 'pet', 'windows'] as const) {
                expect(availability[role].kind).toBe('unavailable');
                await expect(host.requireDesktopHostRole(role)).rejects.toMatchObject({ code: 'desktop_host_unavailable', role });
            }
            expect(invoke).not.toHaveBeenCalled();
            expect(coreInvokeSpy).not.toHaveBeenCalled();
            expect(listenSpy).not.toHaveBeenCalled();
        });

        it('shares one pending acquisition and updates only a failed role from pushed window state', async () => {
            vi.resetModules();
            const available = { kind: 'available' } as const;
            let settle: (value: unknown) => void = () => {};
            const invoke = vi.fn(() => new Promise(resolve => { settle = resolve; }));
            writeGlobal(TAURI_INTERNALS_KEY, { invoke });
            const handlers = new Map<string, (event: { payload: unknown }) => void>();
            listenSpy.mockImplementation(async (event, handler) => {
                handlers.set(event, handler);
                return () => { handlers.delete(event); };
            });
            const host = await import('./desktopHost');
            const first = host.getDesktopHostAvailability();
            const second = host.getDesktopHostAvailability();
            expect(host.getDesktopHostAvailabilitySnapshot()).toBeNull();
            await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
            settle({ activity: available, pet: available, windows: available });
            const initial = await first;
            expect(await second).toBe(initial);
            expect(invoke).toHaveBeenCalledTimes(1);
            expect(invoke).toHaveBeenCalledWith('desktop_host_get_availability', undefined);
            const failure = { kind: 'unavailable', reason: 'panel_host_apply_failed' } as const;
            handlers.get('activityOverlay://state')?.({ payload: { availability: { activity: failure } } });
            const next = host.getDesktopHostAvailabilitySnapshot();
            expect(next?.activity).toEqual(failure);
            expect(next?.pet).toBe(initial.pet);
            expect(next?.windows).toBe(initial.windows);
            await expect(host.requireDesktopHostRole('activity')).rejects.toMatchObject({ reason: failure.reason });
            await expect(host.requireDesktopHostRole('pet')).resolves.toBeUndefined();
            const petFailure = { kind: 'unavailable', reason: 'pointer_unavailable' } as const;
            handlers.get('desktop_pet_overlay_window_state_changed')?.({ payload: { availability: { pet: petFailure } } });
            expect(host.getDesktopHostAvailabilitySnapshot()?.pet).toEqual(petFailure);
            expect(host.getDesktopHostAvailabilitySnapshot()?.windows).toBe(initial.windows);
            await expect(host.requireDesktopHostRole('pet')).rejects.toMatchObject({ reason: petFailure.reason });
            expect(invoke).toHaveBeenCalledTimes(1);
        });
    });
});
