import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeDesktopHostMock = vi.hoisted(() => vi.fn());
const listenDesktopHostEventMock = vi.hoisted(() => vi.fn());
const isDesktopHostMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/platform/desktopHost', () => ({
    invokeDesktopHost: (command: string, args?: Record<string, unknown>) => invokeDesktopHostMock(command, args),
    listenDesktopHostEvent: (eventName: string, handler: (payload: unknown) => void) => listenDesktopHostEventMock(eventName, handler),
    isDesktopHost: () => isDesktopHostMock(),
}));

describe('desktopWindowBridge', () => {
    afterEach(() => {
        vi.resetModules();
        invokeDesktopHostMock.mockReset();
        listenDesktopHostEventMock.mockReset();
        isDesktopHostMock.mockReset();
    });

    it('returns a disabled chrome policy when the host is not Tauri desktop', async () => {
        isDesktopHostMock.mockReturnValue(false);

        const { getDesktopWindowChromePolicy } = await import('./desktopWindowBridge');

        await expect(getDesktopWindowChromePolicy()).resolves.toEqual({
            strategy: 'none',
        });
        expect(invokeDesktopHostMock).not.toHaveBeenCalled();
    });

    it('falls back to a disabled policy when the runtime policy lookup fails', async () => {
        isDesktopHostMock.mockReturnValue(true);
        invokeDesktopHostMock.mockRejectedValue(new Error('unavailable'));

        const { getDesktopWindowChromePolicy } = await import('./desktopWindowBridge');

        await expect(getDesktopWindowChromePolicy()).resolves.toEqual({
            strategy: 'none',
        });
    });

    it('routes actions through invokeDesktopHost when the current window policy allows chrome controls', async () => {
        isDesktopHostMock.mockReturnValue(true);

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

        invokeDesktopHostMock.mockImplementation(async (command: string) => {
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

        expect(invokeDesktopHostMock).toHaveBeenCalledWith(DESKTOP_WINDOW_MINIMIZE_COMMAND, undefined);
        expect(invokeDesktopHostMock).toHaveBeenCalledWith(DESKTOP_WINDOW_TOGGLE_MAXIMIZE_COMMAND, undefined);
        expect(invokeDesktopHostMock).toHaveBeenCalledWith(DESKTOP_WINDOW_CLOSE_COMMAND, undefined);
        expect(invokeDesktopHostMock).toHaveBeenCalledWith(DESKTOP_WINDOW_START_DRAGGING_COMMAND, undefined);
    });

    it('no-ops actions when the current window policy is disabled', async () => {
        isDesktopHostMock.mockReturnValue(true);

        const {
            DESKTOP_WINDOW_CHROME_POLICY_COMMAND,
            DESKTOP_WINDOW_MINIMIZE_COMMAND,
            minimizeDesktopWindow,
        } = await import('./desktopWindowBridge');

        invokeDesktopHostMock.mockImplementation(async (command: string) => {
            if (command === DESKTOP_WINDOW_CHROME_POLICY_COMMAND) {
                return {
                    strategy: 'none',
                };
            }

            return true;
        });

        await minimizeDesktopWindow();

        expect(invokeDesktopHostMock).not.toHaveBeenCalledWith(DESKTOP_WINDOW_MINIMIZE_COMMAND, undefined);
    });

    it('returns a default unmaximized state when desktop is unavailable or policy is disabled', async () => {
        isDesktopHostMock.mockReturnValue(false);

        const { getDesktopWindowState } = await import('./desktopWindowBridge');

        await expect(getDesktopWindowState()).resolves.toEqual({
            isMaximized: false,
        });

        vi.resetModules();
        invokeDesktopHostMock.mockReset();
        listenDesktopHostEventMock.mockReset();
        isDesktopHostMock.mockReset();
        isDesktopHostMock.mockReturnValue(true);
        invokeDesktopHostMock.mockResolvedValue({
            strategy: 'none',
        });

        const disabledWindowBridge = await import('./desktopWindowBridge');

        await expect(disabledWindowBridge.getDesktopWindowState()).resolves.toEqual({
            isMaximized: false,
        });
    });

    it('syncs initial and event-driven window state through the backend bridge', async () => {
        isDesktopHostMock.mockReturnValue(true);
        const handler = vi.fn();
        const unlisten = vi.fn();

        const {
            DESKTOP_WINDOW_CHROME_POLICY_COMMAND,
            DESKTOP_WINDOW_EVENTS,
            DESKTOP_WINDOW_STATE_COMMAND,
            listenDesktopWindowState,
        } = await import('./desktopWindowBridge');

        invokeDesktopHostMock.mockImplementation(async (command: string) => {
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
        listenDesktopHostEventMock.mockImplementation(async (eventName: string, nextHandler: (payload: unknown) => void) => {
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
        isDesktopHostMock.mockReturnValue(true);
        const handler = vi.fn();

        const {
            DESKTOP_WINDOW_CHROME_POLICY_COMMAND,
            DESKTOP_WINDOW_STATE_COMMAND,
            getDesktopWindowState,
            listenDesktopWindowState,
        } = await import('./desktopWindowBridge');

        invokeDesktopHostMock.mockImplementation(async (command: string) => {
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
        listenDesktopHostEventMock.mockRejectedValue(new Error('listen failed'));

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
