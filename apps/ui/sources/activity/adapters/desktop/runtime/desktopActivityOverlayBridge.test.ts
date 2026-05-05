import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeTauriMock = vi.hoisted(() => vi.fn());
const listenTauriEventMock = vi.hoisted(() => vi.fn());

function expectTauriEventHandler(handler: unknown): asserts handler is (payload: unknown) => void {
    expect(handler).toBeTypeOf('function');
    if (typeof handler !== 'function') {
        throw new Error('Expected Tauri event handler to be captured');
    }
}

vi.mock('@/utils/platform/tauri', () => ({
    invokeTauri: (command: string, args?: Record<string, unknown>) => invokeTauriMock(command, args),
    listenTauriEvent: (eventName: string, handler: (payload: unknown) => void) => listenTauriEventMock(eventName, handler),
}));

describe('desktopActivityOverlayBridge', () => {
    afterEach(() => {
        invokeTauriMock.mockReset();
        listenTauriEventMock.mockReset();
    });

    it('syncs overlay state through tauri invoke', async () => {
        const { syncDesktopActivityOverlay } = await import('./desktopActivityOverlayBridge');

        await syncDesktopActivityOverlay({
            visible: true,
            expanded: false,
            model: {
                visible: true,
                isExpanded: false,
                generatedAt: Date.now(),
                collapsed: {
                    title: 'Primary',
                    statusText: null,
                    defaultTarget: 'open-primary-session',
                    sessionCount: 1,
                },
                expanded: {
                    title: 'Sessions',
                    rows: [],
                },
                window: {
                    collapsed: { width: 320, height: 72 },
                    expanded: { width: 420, height: 240 },
                },
            },
            window: {
                collapsed: { width: 320, height: 72 },
                expanded: { width: 420, height: 240 },
            },
            policy: {
                enabled: true,
                visibilityMode: 'attention_only',
                showWhenRunning: true,
                showWhenAttentionRequired: true,
                showWhenReady: true,
                alwaysOnTop: true,
                autoHideEnabled: true,
                autoHideDelayMs: 6000,
                hoverExpandDelayMs: 500,
                expandedBehavior: 'click',
                interactiveCollapsed: true,
                presentationMode: 'automatic',
                clickAction: 'expand_overlay',
                density: 'compact',
                compactStyle: 'pill',
                showSessionCount: true,
                showPreviewText: false,
                quickReplyPhrases: ['Continue', 'OK', 'Explain', 'Retry'],
                placementMode: 'anchored',
                anchor: 'top_center',
                offsetX: 0,
                offsetY: 0,
                enableDragReposition: false,
                lockPosition: true,
            },
        });

        expect(invokeTauriMock).toHaveBeenCalledWith('desktop_activity_overlay_sync', expect.objectContaining({
            payload: expect.objectContaining({
                visible: true,
            }),
        }));
    });

    it('subscribes to state updates through listenTauriEvent', async () => {
        listenTauriEventMock.mockResolvedValue(() => {});
        const { listenDesktopActivityOverlayWindowState, DESKTOP_ACTIVITY_OVERLAY_EVENTS } = await import('./desktopActivityOverlayBridge');
        const handler = vi.fn();

        await listenDesktopActivityOverlayWindowState(handler);

        expect(listenTauriEventMock).toHaveBeenCalledWith(DESKTOP_ACTIVITY_OVERLAY_EVENTS.state, handler);
    });

    it('resets the persisted overlay position through tauri invoke', async () => {
        const { resetDesktopActivityOverlayPosition } = await import('./desktopActivityOverlayBridge');

        await resetDesktopActivityOverlayPosition();

        expect(invokeTauriMock).toHaveBeenCalledWith('desktop_activity_overlay_reset_position', undefined);
    });

    it('releases drag velocity through the activity overlay command namespace', async () => {
        const bridge = await import('./desktopActivityOverlayBridge');
        const releaseDragVelocity = (bridge as Record<string, unknown>).releaseDesktopActivityOverlayDragVelocity;
        expect(releaseDragVelocity).toBeTypeOf('function');
        if (typeof releaseDragVelocity !== 'function') {
            return;
        }

        await releaseDragVelocity({
            pointerId: 9,
            vx: 640,
            vy: -320,
            sampleWindowMs: 100,
        });

        expect(invokeTauriMock).toHaveBeenCalledWith('desktop_activity_overlay_release_drag_velocity', {
            payload: {
                pointerId: '9',
                vx: 640,
                vy: -320,
                sampleWindowMs: 100,
            },
        });
    });

    it('sets the native overlay input lock through tauri invoke', async () => {
        const { setDesktopActivityOverlayInputLocked } = await import('./desktopActivityOverlayBridge');

        await setDesktopActivityOverlayInputLocked(true);

        expect(invokeTauriMock).toHaveBeenCalledWith('desktop_activity_overlay_set_input_locked', { locked: true });
    });

    it('reveals the main window through tauri invoke before route-driven overlay interactions', async () => {
        const { showDesktopMainWindow } = await import('./desktopActivityOverlayBridge');

        await showDesktopMainWindow();

        expect(invokeTauriMock).toHaveBeenCalledWith('desktop_show_main_window', undefined);
    });

    it('resolves an overlay interaction request from the matching result event', async () => {
        const resultHandlerRef: { current?: (payload: unknown) => void } = {};
        const unlisten = vi.fn();
        listenTauriEventMock.mockImplementation(async (eventName: string, handler: (payload: unknown) => void) => {
            if (eventName === 'activityOverlay://interaction-result') {
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

        await vi.waitFor(() => expect(invokeTauriMock).toHaveBeenCalledWith('desktop_activity_overlay_emit_interaction', {
            payload: expect.objectContaining({
                requestId: 'quick-reply-request-1',
            }),
        }));
        const resultHandler = resultHandlerRef.current;
        expectTauriEventHandler(resultHandler);

        resultHandler({
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
