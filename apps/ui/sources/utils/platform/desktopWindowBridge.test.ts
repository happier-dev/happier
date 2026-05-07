import { afterEach, describe, expect, it, vi } from 'vitest';

const tauriState = vi.hoisted(() => ({
    isDesktop: false,
    invoke: vi.fn(),
    listen: vi.fn(),
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriState.isDesktop,
    invokeTauri: (command: string, args?: Record<string, unknown>) => tauriState.invoke(command, args),
    listenTauriEvent: (eventName: string, handler: (payload: unknown) => void) => tauriState.listen(eventName, handler),
}));

describe('desktopWindowBridge', () => {
    afterEach(() => {
        tauriState.isDesktop = false;
        tauriState.invoke.mockReset();
        tauriState.listen.mockReset();
    });

    it('disables window chrome safely outside Tauri', async () => {
        const bridge = await import('./desktopWindowBridge');
        const states: unknown[] = [];

        await bridge.minimizeDesktopWindow();
        await bridge.toggleDesktopWindowMaximize();
        await bridge.closeDesktopWindow();
        await bridge.startDesktopWindowDragging();
        const cleanup = await bridge.listenDesktopWindowState((state) => states.push(state));

        expect(await bridge.getDesktopWindowChromePolicy()).toEqual({ strategy: 'none' });
        expect(await bridge.getDesktopWindowState()).toEqual({ isMaximized: false });
        expect(states).toEqual([{ isMaximized: false }]);
        await expect(cleanup()).resolves.toBeUndefined();
        expect(tauriState.invoke).not.toHaveBeenCalled();
        expect(tauriState.listen).not.toHaveBeenCalled();
    });

    it('normalizes malformed native policy and state payloads', async () => {
        tauriState.isDesktop = true;
        tauriState.invoke.mockImplementation(async (command: string) => {
            if (command === 'desktop_get_window_chrome_policy') {
                return { strategy: 'unsupported' };
            }
            if (command === 'desktop_get_window_state') {
                return { isMaximized: 'yes' };
            }
            return true;
        });

        const bridge = await import('./desktopWindowBridge');

        expect(await bridge.getDesktopWindowChromePolicy()).toEqual({ strategy: 'none' });
        expect(await bridge.getDesktopWindowState()).toEqual({ isMaximized: false });
        await bridge.startDesktopWindowDragging();
        expect(tauriState.invoke.mock.calls.map(([command]) => command)).toEqual([
            'desktop_get_window_chrome_policy',
            'desktop_get_window_chrome_policy',
            'desktop_get_window_chrome_policy',
        ]);
    });

    it('guards native commands behind a supported chrome policy', async () => {
        tauriState.isDesktop = true;
        tauriState.invoke.mockImplementation(async (command: string) => {
            if (command === 'desktop_get_window_chrome_policy') {
                return { strategy: 'custom-controls' };
            }
            if (command === 'desktop_get_window_state') {
                return { isMaximized: true };
            }
            return true;
        });

        const bridge = await import('./desktopWindowBridge');

        expect(await bridge.getDesktopWindowState()).toEqual({ isMaximized: true });
        await bridge.minimizeDesktopWindow();
        await bridge.toggleDesktopWindowMaximize();
        await bridge.closeDesktopWindow();
        await bridge.startDesktopWindowDragging();

        expect(tauriState.invoke.mock.calls.map(([command]) => command)).toEqual([
            'desktop_get_window_chrome_policy',
            'desktop_get_window_state',
            'desktop_get_window_chrome_policy',
            'desktop_minimize_window',
            'desktop_get_window_chrome_policy',
            'desktop_toggle_window_maximize',
            'desktop_get_window_chrome_policy',
            'desktop_close_window',
            'desktop_get_window_chrome_policy',
            'desktop_start_window_dragging',
        ]);
    });

    it('emits normalized initial and live window state with resilient cleanup', async () => {
        tauriState.isDesktop = true;
        let liveHandler: ((payload: unknown) => void) | undefined;
        const unlisten = vi.fn(() => {
            throw new Error('window already closed');
        });

        tauriState.invoke.mockImplementation(async (command: string) => {
            if (command === 'desktop_get_window_chrome_policy') {
                return { strategy: 'custom-controls' };
            }
            if (command === 'desktop_get_window_state') {
                return { isMaximized: true };
            }
            return true;
        });
        tauriState.listen.mockImplementation(async (_eventName: string, handler: (payload: unknown) => void) => {
            liveHandler = handler;
            return unlisten;
        });

        const bridge = await import('./desktopWindowBridge');
        const states: unknown[] = [];
        const cleanup = await bridge.listenDesktopWindowState((state) => states.push(state));
        liveHandler?.({ isMaximized: 'not-a-boolean' });
        liveHandler?.({ isMaximized: true });

        expect(states).toEqual([
            { isMaximized: true },
            { isMaximized: false },
            { isMaximized: true },
        ]);
        expect(tauriState.listen).toHaveBeenCalledWith('desktopWindow://state', expect.any(Function));
        await expect(cleanup()).resolves.toBeUndefined();
    });
});
