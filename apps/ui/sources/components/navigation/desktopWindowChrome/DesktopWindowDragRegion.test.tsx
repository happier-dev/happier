import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const desktopWindowBridgeState = vi.hoisted(() => ({
    startDesktopWindowDragging: vi.fn(),
    toggleDesktopWindowMaximize: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
        },
    });
});

vi.mock('@/utils/platform/desktopWindowBridge', () => ({
    startDesktopWindowDragging: () => desktopWindowBridgeState.startDesktopWindowDragging(),
    toggleDesktopWindowMaximize: () => desktopWindowBridgeState.toggleDesktopWindowMaximize(),
}));

describe('useDesktopWindowDragMouseProps', () => {
    beforeEach(() => {
        desktopWindowBridgeState.startDesktopWindowDragging.mockReset();
        desktopWindowBridgeState.toggleDesktopWindowMaximize.mockReset();
        vi.resetModules();
    });

    it('starts dragging once from pointer down and suppresses the follow-up mouse fallback', async () => {
        const { useDesktopWindowDragMouseProps } = await import('./DesktopWindowDragRegion');
        const hook = await renderHook(() => useDesktopWindowDragMouseProps(), {
            flushOptions: { cycles: 1, turns: 1 },
        });
        const dragProps = hook.getCurrent();
        const preventDefault = vi.fn();
        const draggableTarget = { closest: vi.fn(() => null) };

        dragProps.onPointerDown?.({
            buttons: 1,
            preventDefault,
            target: draggableTarget,
        });
        dragProps.onMouseDown?.({
            buttons: 1,
            preventDefault,
            target: draggableTarget,
        });

        expect(dragProps['data-tauri-drag-region']).toBe(true);
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(desktopWindowBridgeState.startDesktopWindowDragging).toHaveBeenCalledTimes(1);
        expect(desktopWindowBridgeState.toggleDesktopWindowMaximize).not.toHaveBeenCalled();
    });

    it('toggles maximize from double-click titlebar mouse down without starting a drag', async () => {
        const { useDesktopWindowDragMouseProps } = await import('./DesktopWindowDragRegion');
        const hook = await renderHook(() => useDesktopWindowDragMouseProps(), {
            flushOptions: { cycles: 1, turns: 1 },
        });
        const dragProps = hook.getCurrent();
        const preventDefault = vi.fn();
        const draggableTarget = { closest: vi.fn(() => null) };

        dragProps.onMouseDown?.({
            buttons: 1,
            detail: 2,
            preventDefault,
            target: draggableTarget,
        });

        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(desktopWindowBridgeState.toggleDesktopWindowMaximize).toHaveBeenCalledTimes(1);
        expect(desktopWindowBridgeState.startDesktopWindowDragging).not.toHaveBeenCalled();
    });

    it('does not start dragging from nested interactive controls', async () => {
        const { useDesktopWindowDragMouseProps } = await import('./DesktopWindowDragRegion');
        const hook = await renderHook(() => useDesktopWindowDragMouseProps(), {
            flushOptions: { cycles: 1, turns: 1 },
        });
        const dragProps = hook.getCurrent();
        const preventDefault = vi.fn();
        const interactiveTarget = { closest: vi.fn(() => ({ role: 'button' })) };

        dragProps.onPointerDown?.({
            buttons: 1,
            preventDefault,
            target: interactiveTarget,
        });

        expect(preventDefault).not.toHaveBeenCalled();
        expect(desktopWindowBridgeState.startDesktopWindowDragging).not.toHaveBeenCalled();
        expect(desktopWindowBridgeState.toggleDesktopWindowMaximize).not.toHaveBeenCalled();
    });
});
