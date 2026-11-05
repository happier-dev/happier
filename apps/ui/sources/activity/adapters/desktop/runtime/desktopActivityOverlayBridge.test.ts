import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeDesktopHostMock = vi.hoisted(() => vi.fn());
const listenDesktopHostEventMock = vi.hoisted(() => vi.fn());

function expectTauriEventHandler(handler: unknown): asserts handler is (payload: unknown) => void {
    expect(handler).toBeTypeOf('function');
    if (typeof handler !== 'function') {
        throw new Error('Expected Tauri event handler to be captured');
    }
}

// The native IPC/event packages are the boundary; host admission remains real.
vi.mock('@tauri-apps/api/event', () => ({
    listen: (eventName: string, handler: (event: { payload: unknown }) => void) =>
        listenDesktopHostEventMock(eventName, (payload: unknown) => handler({ payload })),
}));

describe('desktopActivityOverlayBridge', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubGlobal('navigator', { userAgent: 'Tauri' });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_host_get_availability') return {
                activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' },
            };
            return invokeDesktopHostMock(command, args);
        } });
        listenDesktopHostEventMock.mockResolvedValue(() => {});
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        invokeDesktopHostMock.mockReset();
        listenDesktopHostEventMock.mockReset();
    });

    it('settles unsupported Electron presentation without invoking its Tauri-shaped bridge', async () => {
        vi.stubGlobal('navigator', { userAgent: 'Happier Electron/43.4' });
        const bridge = await import('./desktopActivityOverlayBridge');
        await expect(bridge.presentDesktopActivityOverlay({
            surface: 'peek', engaged: true, extent: { width: 300, height: 100 },
        })).rejects.toMatchObject({ code: 'desktop_host_unavailable', role: 'activity' });
        expect(invokeDesktopHostMock).not.toHaveBeenCalled();
        expect(listenDesktopHostEventMock).not.toHaveBeenCalled();
    });

    it('sends measured start and settled extents through one presentation command', async () => {
        const bridge = await import('./desktopActivityOverlayBridge');
        await bridge.presentDesktopActivityOverlay({
            surface: 'peek', engaged: true, extent: { width: 340, height: 120, cameraOffset: 20 }, settled: false,
        });
        await bridge.presentDesktopActivityOverlay({
            surface: 'tip', engaged: false, extent: { width: 80, height: 16 }, settled: true,
        });
        expect(invokeDesktopHostMock.mock.calls).toEqual([
            ['desktop_activity_overlay_present', { payload: { surface: 'peek', engaged: true, extent: { width: 340, height: 120, cameraOffset: 20 }, settled: false } }],
            ['desktop_activity_overlay_present', { payload: { surface: 'tip', engaged: false, extent: { width: 80, height: 16 }, settled: true } }],
        ]);
    });

    it('subscribes to state updates through listenDesktopHostEvent', async () => {
        listenDesktopHostEventMock.mockResolvedValue(() => {});
        const { listenDesktopActivityOverlayWindowState, DESKTOP_ACTIVITY_OVERLAY_EVENTS } = await import('./desktopActivityOverlayBridge');
        const handler = vi.fn();

        await listenDesktopActivityOverlayWindowState(handler);

        const registration = listenDesktopHostEventMock.mock.calls.at(-1);
        expect(registration?.[0]).toBe(DESKTOP_ACTIVITY_OVERLAY_EVENTS.state);
        const onState = registration?.[1];
        expectTauriEventHandler(onState);
        onState({ visible: false });
        expect(handler).toHaveBeenCalledWith({ visible: false });
    });

    it('reveals the main window through tauri invoke before route-driven overlay interactions', async () => {
        const { showDesktopMainWindow } = await import('./desktopActivityOverlayBridge');

        await showDesktopMainWindow();

        expect(invokeDesktopHostMock).toHaveBeenCalledWith('desktop_show_main_window', undefined);
    });

    it('resolves an overlay interaction request from the matching result event', async () => {
        const resultHandlerRef: { current?: (payload: unknown) => void } = {};
        const unlisten = vi.fn();
        listenDesktopHostEventMock.mockImplementation(async (eventName: string, handler: (payload: unknown) => void) => {
            if (eventName === 'desktopWindow://action-result') {
                resultHandlerRef.current = handler;
            }
            return unlisten;
        });

        const { executeDesktopActivityOverlayInteractionWithResult } = await import('./desktopActivityOverlayBridge');

        const resultPromise = executeDesktopActivityOverlayInteractionWithResult({
            requestId: 'quick-reply-request-1',
            actionIdentifier: 'session.message.send',
            data: {
                sessionId: 'session-1',
                serverId: 'server-1',
                message: 'Continue',
            },
        });

        await vi.waitFor(() => expect(invokeDesktopHostMock).toHaveBeenCalledWith('desktop_window_emit_action', {
            payload: expect.objectContaining({
                requestId: 'quick-reply-request-1',
            }),
        }));
        const resultHandler = resultHandlerRef.current;
        expectTauriEventHandler(resultHandler);

        resultHandler({
            windowLabel: 'activity_overlay',
            requestId: 'quick-reply-request-1',
            ok: false,
            errorCode: 'action_failed',
        });

        await expect(resultPromise).resolves.toEqual({
            requestId: 'quick-reply-request-1',
            ok: false,
            errorCode: 'action_failed',
        });
        expect(unlisten).toHaveBeenCalledTimes(1);
    });
});
