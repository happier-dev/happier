import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeTauriMock = vi.hoisted(() => vi.fn());
const listenTauriEventMock = vi.hoisted(() => vi.fn());

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
                expandedBehavior: 'click',
                interactiveCollapsed: true,
                clickAction: 'expand_overlay',
                density: 'compact',
                compactStyle: 'pill',
                showSessionCount: true,
                showPreviewText: false,
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
});
