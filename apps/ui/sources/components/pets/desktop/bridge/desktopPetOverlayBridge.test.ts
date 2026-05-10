import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const invokeTauriMock = vi.hoisted(() => vi.fn());
const listenTauriEventMock = vi.hoisted(() => vi.fn());
const isTauriDesktopMock = vi.hoisted(() => vi.fn(() => true));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => isTauriDesktopMock(),
    invokeTauri: (command: string, args?: Record<string, unknown>) => invokeTauriMock(command, args),
    listenTauriEvent: (eventName: string, handler: (payload: unknown) => void) => listenTauriEventMock(eventName, handler),
}));

describe('desktopPetOverlayBridge', () => {
    afterEach(() => {
        vi.useRealTimers();
        invokeTauriMock.mockReset();
        listenTauriEventMock.mockReset();
        isTauriDesktopMock.mockReset();
        isTauriDesktopMock.mockReturnValue(true);
    });

    it('syncs state using the native pet overlay command payload shape', async () => {
        const { syncDesktopPetOverlayState } = await import('./desktopPetOverlayBridge');

        await syncDesktopPetOverlayState({
            visible: true,
            expanded: false,
            window: { width: 192, height: 208 },
            policy: {
                enabled: true,
                alwaysOnTop: true,
                inputLocked: false,
                anchor: 'bottomRight',
            },
        });

        expect(invokeTauriMock).toHaveBeenCalledWith('sync_desktop_pet_overlay_state', {
            payload: expect.objectContaining({
                visible: true,
                window: { width: 192, height: 208 },
                policy: expect.objectContaining({
                    alwaysOnTop: true,
                    inputLocked: false,
                }),
            }),
        });
    });

    it('serializes every native command name exactly once through the bridge', async () => {
        const bridge = await import('./desktopPetOverlayBridge');

        await bridge.getDesktopPetOverlayWindowState();
        await bridge.setDesktopPetOverlayInputLocked({ locked: true, reason: 'hidden' });
        await bridge.startDesktopPetOverlayDragSession({
            pointerId: 9,
            screenX: 100,
            screenY: 200,
            startedAtMs: 300,
        });
        await bridge.applyDesktopPetOverlayDragDelta({
            pointerId: 9,
            dx: 12,
            dy: -8,
            coordinateSpace: 'screen',
        });
        await bridge.releaseDesktopPetOverlayDragVelocity({
            pointerId: 9,
            vx: 640,
            vy: -320,
            sampleWindowMs: 100,
        });
        await bridge.applyDesktopPetOverlayMomentumDelta({
            generation: 42,
            dx: 6,
            dy: -3,
        });
        await bridge.syncDesktopPetOverlayElementMetrics({
            isTrayVisible: true,
            mascot: { x: 240, y: 188, width: 116, height: 124 },
            tray: { x: 24, y: 28, width: 276, height: 112 },
            controls: { x: 310, y: 176, width: 30, height: 30 },
        });
        await bridge.endDesktopPetOverlayDragSession({
            pointerId: 9,
            cancelled: false,
            screenX: 112,
            screenY: 192,
        });
        await bridge.resetDesktopPetOverlayPosition();
        await bridge.emitDesktopPetOverlayInteractionResult({ requestId: 'request-1', ok: true });
        await bridge.showMainWindowFromDesktopPetOverlay({ reason: 'mascot-click' });

        expect(invokeTauriMock.mock.calls.map(([command]) => command)).toEqual([
            'desktop_pet_overlay_read_window_state',
            'desktop_pet_overlay_set_input_locked',
            'desktop_pet_overlay_start_drag_session',
            'desktop_pet_overlay_apply_drag_delta',
            'desktop_pet_overlay_release_drag_velocity',
            'desktop_pet_overlay_apply_momentum_delta',
            'desktop_pet_overlay_sync_element_metrics',
            'desktop_pet_overlay_end_drag_session',
            'desktop_pet_overlay_reset_position',
            'emit_desktop_pet_overlay_interaction_result',
            'desktop_pet_overlay_show_main_window',
        ]);
        expect(invokeTauriMock).toHaveBeenCalledWith('desktop_pet_overlay_apply_drag_delta', {
            payload: {
                pointerId: '9',
                dx: 12,
                dy: -8,
                coordinateSpace: 'screen',
            },
        });
        expect(invokeTauriMock).toHaveBeenCalledWith('desktop_pet_overlay_release_drag_velocity', {
            payload: {
                pointerId: '9',
                vx: 640,
                vy: -320,
                sampleWindowMs: 100,
            },
        });
        expect(invokeTauriMock).toHaveBeenCalledWith('desktop_pet_overlay_apply_momentum_delta', {
            payload: {
                generation: 42,
                dx: 6,
                dy: -3,
            },
        });
        expect(invokeTauriMock).toHaveBeenCalledWith('desktop_pet_overlay_sync_element_metrics', {
            payload: {
                isTrayVisible: true,
                mascot: { x: 240, y: 188, width: 116, height: 124 },
                tray: { x: 24, y: 28, width: 276, height: 112 },
                controls: { x: 310, y: 176, width: 30, height: 30 },
            },
        });
    });

    it('ignores element metric sync outside the Tauri desktop shell', async () => {
        isTauriDesktopMock.mockReturnValue(false);
        const { syncDesktopPetOverlayElementMetrics } = await import('./desktopPetOverlayBridge');

        await syncDesktopPetOverlayElementMetrics({
            isTrayVisible: false,
            mascot: { x: 0, y: 0, width: 1, height: 1 },
            tray: { x: 0, y: 0, width: 1, height: 1 },
            controls: { x: 0, y: 0, width: 1, height: 1 },
        });

        expect(invokeTauriMock).not.toHaveBeenCalled();
    });

    it('schedules native momentum deltas from the release velocity plan', async () => {
        vi.useFakeTimers();
        invokeTauriMock.mockImplementation(async (command) => {
            if (command === 'desktop_pet_overlay_release_drag_velocity') {
                return {
                    generation: 42,
                    tickMs: 16,
                    deltas: [
                        { dx: 8, dy: -4, delayMs: 16 },
                        { dx: 4, dy: -2, delayMs: 16 },
                    ],
                };
            }
            return undefined;
        });
        const { releaseDesktopPetOverlayDragVelocity } = await import('./desktopPetOverlayBridge');

        await releaseDesktopPetOverlayDragVelocity({
            pointerId: 9,
            vx: 640,
            vy: -320,
            sampleWindowMs: 100,
        });
        await vi.advanceTimersByTimeAsync(16);
        await vi.advanceTimersByTimeAsync(16);

        expect(invokeTauriMock.mock.calls).toEqual([
            [
                'desktop_pet_overlay_release_drag_velocity',
                {
                    payload: {
                        pointerId: '9',
                        vx: 640,
                        vy: -320,
                        sampleWindowMs: 100,
                    },
                },
            ],
            [
                'desktop_pet_overlay_apply_momentum_delta',
                {
                    payload: {
                        generation: 42,
                        dx: 8,
                        dy: -4,
                    },
                },
            ],
            [
                'desktop_pet_overlay_apply_momentum_delta',
                {
                    payload: {
                        generation: 42,
                        dx: 4,
                        dy: -2,
                    },
                },
            ],
        ]);
    });

    it('models native layout as part of the window state payload', async () => {
        const { listenDesktopPetOverlayWindowState } = await import('./desktopPetOverlayBridge');
        const payloads: unknown[] = [];
        listenTauriEventMock.mockImplementation(async (_eventName, handler) => {
            handler({
                visible: true,
                inputLocked: false,
                monitorId: null,
                logicalPosition: { x: 100, y: 200 },
                logicalSize: { width: 312, height: 244 },
                scaleFactor: 2,
                lastPlacementRecoveryCode: null,
                layout: {
                    placement: 'topEnd',
                    window: { width: 312, height: 244 },
                    mascot: { left: 196, top: 120, width: 116, height: 124 },
                    tray: { left: 0, top: 0, width: 276, height: 112 },
                    controls: { left: 266, top: 108, width: 30, height: 30 },
                },
            });
            return () => {};
        });

        await listenDesktopPetOverlayWindowState((payload) => payloads.push(payload));

        expect(payloads).toEqual([
            expect.objectContaining({
                layout: {
                    placement: 'topEnd',
                    window: { width: 312, height: 244 },
                    mascot: { left: 196, top: 120, width: 116, height: 124 },
                    tray: { left: 0, top: 0, width: 276, height: 112 },
                    controls: { left: 266, top: 108, width: 30, height: 30 },
                },
            }),
        ]);
    });

    it('subscribes only to native-emitted pet overlay event channels', async () => {
        listenTauriEventMock.mockResolvedValue(() => {});
        const bridge = await import('./desktopPetOverlayBridge');

        await bridge.listenDesktopPetOverlayWindowState(() => {});
        await bridge.listenDesktopPetOverlayInteractionResult(() => {});
        expect(typeof bridge.listenDesktopPetOverlayShowMainWindowRequested).toBe('function');
        await bridge.listenDesktopPetOverlayShowMainWindowRequested(() => {});
        expect(typeof bridge.listenDesktopPetOverlayNativeMouse).toBe('function');
        await bridge.listenDesktopPetOverlayNativeMouse(() => {});

        expect(bridge.DESKTOP_PET_OVERLAY_EVENTS).toEqual({
            windowStateChanged: 'desktop_pet_overlay_window_state_changed',
            interactionResult: 'desktop_pet_overlay_interaction_result',
            showMainWindowRequested: 'desktop_pet_overlay_show_main_window_requested',
            nativeMouseChanged: 'desktop_pet_overlay_native_mouse_changed',
        });
        expect(listenTauriEventMock.mock.calls.map(([eventName]) => eventName)).toEqual([
            'desktop_pet_overlay_window_state_changed',
            'desktop_pet_overlay_interaction_result',
            'desktop_pet_overlay_show_main_window_requested',
            'desktop_pet_overlay_native_mouse_changed',
        ]);
    });

    it('keeps TypeScript command labels aligned with registered Rust commands', async () => {
        const { DESKTOP_PET_OVERLAY_COMMANDS } = await import('./desktopPetOverlayBridge');
        const rustLib = readFileSync('src-tauri/src/lib.rs', 'utf8');
        const rustOverlay = readFileSync('src-tauri/src/pet_overlay.rs', 'utf8');

        for (const command of Object.values(DESKTOP_PET_OVERLAY_COMMANDS)) {
            expect(rustOverlay).toContain(`pub fn ${command}`);
            expect(rustLib).toContain(`pet_overlay::${command}`);
        }
    });

    it('keeps TypeScript overlay padding aligned with the Rust monitor placement clamp', async () => {
        const { DESKTOP_PET_OVERLAY_PLACEMENT_PADDING_PX } = await import('../desktopPetOverlayGeometry');
        const rustOverlay = readFileSync('src-tauri/src/pet_overlay.rs', 'utf8');
        const rustPadding = /const PET_OVERLAY_PLACEMENT_PADDING_PX: f64 = ([\d.]+);/.exec(rustOverlay)?.[1];

        expect(Number(rustPadding)).toBe(DESKTOP_PET_OVERLAY_PLACEMENT_PADDING_PX);
    });
});
