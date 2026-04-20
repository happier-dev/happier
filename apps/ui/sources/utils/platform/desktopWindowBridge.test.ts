import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeTauriMock = vi.hoisted(() => vi.fn());
const listenTauriEventMock = vi.hoisted(() => vi.fn());
const isTauriDesktopMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/platform/tauri', () => ({
    invokeTauri: (command: string, args?: Record<string, unknown>) => invokeTauriMock(command, args),
    listenTauriEvent: (eventName: string, handler: (payload: unknown) => void) => listenTauriEventMock(eventName, handler),
    isTauriDesktop: () => isTauriDesktopMock(),
}));

describe('desktopWindowBridge', () => {
    afterEach(() => {
        vi.resetModules();
        invokeTauriMock.mockReset();
        listenTauriEventMock.mockReset();
        isTauriDesktopMock.mockReset();
    });

    it('returns a disabled chrome policy when the host is not Tauri desktop', async () => {
        isTauriDesktopMock.mockReturnValue(false);

        const { getDesktopWindowChromePolicy } = await import('./desktopWindowBridge');

        await expect(getDesktopWindowChromePolicy()).resolves.toEqual({
            strategy: 'none',
        });
        expect(invokeTauriMock).not.toHaveBeenCalled();
    });

    it('falls back to a disabled policy when the runtime policy lookup fails', async () => {
        isTauriDesktopMock.mockReturnValue(true);
        invokeTauriMock.mockRejectedValue(new Error('unavailable'));

        const { getDesktopWindowChromePolicy } = await import('./desktopWindowBridge');

        await expect(getDesktopWindowChromePolicy()).resolves.toEqual({
            strategy: 'none',
        });
    });

    it('routes actions through invokeTauri when the current window policy allows chrome controls', async () => {
        isTauriDesktopMock.mockReturnValue(true);

        const {
            DESKTOP_WINDOW_CHROME_POLICY_COMMAND,
            DESKTOP_WINDOW_CLOSE_COMMAND,
            DESKTOP_WINDOW_MINIMIZE_COMMAND,
            DESKTOP_WINDOW_START_DRAGGING_COMMAND,
            DESKTOP_WINDOW_TOGGLE_MAXIMIZE_COMMAND,
            closeDesktopWindow,
            minimizeDesktopWindow,
            startDesktopWindowDragging,
            toggleDesktopWindowMaximize,
        } = await import('./desktopWindowBridge');

        invokeTauriMock.mockImplementation(async (command: string) => {
            if (command === DESKTOP_WINDOW_CHROME_POLICY_COMMAND) {
                return {
                    strategy: 'custom-controls',
                };
            }

            return true;
        });

        await minimizeDesktopWindow();
        await toggleDesktopWindowMaximize();
        await closeDesktopWindow();
        await startDesktopWindowDragging();

        expect(invokeTauriMock).toHaveBeenCalledWith(DESKTOP_WINDOW_MINIMIZE_COMMAND, undefined);
        expect(invokeTauriMock).toHaveBeenCalledWith(DESKTOP_WINDOW_TOGGLE_MAXIMIZE_COMMAND, undefined);
        expect(invokeTauriMock).toHaveBeenCalledWith(DESKTOP_WINDOW_CLOSE_COMMAND, undefined);
        expect(invokeTauriMock).toHaveBeenCalledWith(DESKTOP_WINDOW_START_DRAGGING_COMMAND, undefined);
    });

    it('no-ops actions when the current window policy is disabled', async () => {
        isTauriDesktopMock.mockReturnValue(true);

        const {
            DESKTOP_WINDOW_CHROME_POLICY_COMMAND,
            DESKTOP_WINDOW_MINIMIZE_COMMAND,
            minimizeDesktopWindow,
        } = await import('./desktopWindowBridge');

        invokeTauriMock.mockImplementation(async (command: string) => {
            if (command === DESKTOP_WINDOW_CHROME_POLICY_COMMAND) {
                return {
                    strategy: 'none',
                };
            }

            return true;
        });

        await minimizeDesktopWindow();

        expect(invokeTauriMock).not.toHaveBeenCalledWith(DESKTOP_WINDOW_MINIMIZE_COMMAND, undefined);
    });

    it('returns a default unmaximized state when desktop is unavailable or policy is disabled', async () => {
        isTauriDesktopMock.mockReturnValue(false);

        const { getDesktopWindowState } = await import('./desktopWindowBridge');

        await expect(getDesktopWindowState()).resolves.toEqual({
            isMaximized: false,
        });

        vi.resetModules();
        invokeTauriMock.mockReset();
        listenTauriEventMock.mockReset();
        isTauriDesktopMock.mockReset();
        isTauriDesktopMock.mockReturnValue(true);
        invokeTauriMock.mockResolvedValue({
            strategy: 'none',
        });

        const disabledWindowBridge = await import('./desktopWindowBridge');

        await expect(disabledWindowBridge.getDesktopWindowState()).resolves.toEqual({
            isMaximized: false,
        });
    });

    it('syncs initial and event-driven window state through the backend bridge', async () => {
        isTauriDesktopMock.mockReturnValue(true);
        const handler = vi.fn();
        const unlisten = vi.fn();

        const {
            DESKTOP_WINDOW_CHROME_POLICY_COMMAND,
            DESKTOP_WINDOW_EVENTS,
            DESKTOP_WINDOW_STATE_COMMAND,
            listenDesktopWindowState,
        } = await import('./desktopWindowBridge');

        invokeTauriMock.mockImplementation(async (command: string) => {
            if (command === DESKTOP_WINDOW_CHROME_POLICY_COMMAND) {
                return {
                    strategy: 'custom-controls',
                };
            }

            if (command === DESKTOP_WINDOW_STATE_COMMAND) {
                return {
                    isMaximized: false,
                };
            }

            return null;
        });

        let eventHandler: ((payload: unknown) => void) | undefined;
        listenTauriEventMock.mockImplementation(async (eventName: string, nextHandler: (payload: unknown) => void) => {
            eventHandler = nextHandler;
            expect(eventName).toBe(DESKTOP_WINDOW_EVENTS.state);
            return unlisten;
        });

        const dispose = await listenDesktopWindowState(handler);

        expect(handler).toHaveBeenCalledWith({
            isMaximized: false,
        });

        const nextEventHandler = eventHandler;
        expect(typeof nextEventHandler).toBe('function');
        if (typeof nextEventHandler === 'function') {
            nextEventHandler({
                isMaximized: true,
            });
        }

        expect(handler).toHaveBeenLastCalledWith({
            isMaximized: true,
        });

        await dispose();

        expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it('handles state lookup and listener failures without throwing', async () => {
        isTauriDesktopMock.mockReturnValue(true);
        const handler = vi.fn();

        const {
            DESKTOP_WINDOW_CHROME_POLICY_COMMAND,
            DESKTOP_WINDOW_STATE_COMMAND,
            getDesktopWindowState,
            listenDesktopWindowState,
        } = await import('./desktopWindowBridge');

        invokeTauriMock.mockImplementation(async (command: string) => {
            if (command === DESKTOP_WINDOW_CHROME_POLICY_COMMAND) {
                return {
                    strategy: 'custom-controls',
                };
            }

            if (command === DESKTOP_WINDOW_STATE_COMMAND) {
                throw new Error('state failed');
            }

            return null;
        });
        listenTauriEventMock.mockRejectedValue(new Error('listen failed'));

        await expect(getDesktopWindowState()).resolves.toEqual({
            isMaximized: false,
        });

        const dispose = await listenDesktopWindowState(handler);

        expect(handler).toHaveBeenCalledWith({
            isMaximized: false,
        });

        await expect(dispose()).resolves.toBeUndefined();
    });
});
