import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import type {
    DesktopBrowserCommandResult,
} from '@/sync/domains/browser/adapters/desktopWebViewBridge';

import {
    useDesktopWebViewSurfaceSync,
    type DesktopWebViewSurfaceSyncBridge,
    type DesktopWebViewSurfaceSyncInput,
    type DesktopWebViewSurfaceRect,
} from '../useDesktopWebViewSurfaceSync';

const okResult: DesktopBrowserCommandResult = {
    ok: true,
    availability: {
        available: true,
        platform: 'macos',
        primitive: 'macosNsViewWebKit',
        renderEngine: 'desktopWebView',
        producer: 'tauriWryNativeChildView',
        privilegedIpc: false,
        supports: {
            navigation: true,
            goBackForward: false,
            reload: false,
            stop: false,
            pageInfoDiagnostics: true,
            nativeDevtools: true,
            capture: false,
            recording: false,
            automation: false,
        },
        disabledReasons: [],
    },
};

function createBridge(): DesktopWebViewSurfaceSyncBridge & {
    setBounds: ReturnType<typeof vi.fn>;
    setPointerPassthrough: ReturnType<typeof vi.fn>;
    closeView: ReturnType<typeof vi.fn>;
} {
    return {
        setBounds: vi.fn(async () => okResult),
        setPointerPassthrough: vi.fn(async () => okResult),
        closeView: vi.fn(async () => okResult),
    };
}

/**
 * A deterministic, hand-driven runtime that replaces the real rAF/ResizeObserver/window-event
 * system boundaries so the hook's decision logic is exercised without a DOM. Frame callbacks and
 * viewport-change notifications are flushed manually; this is a system-boundary fake, not a mock of
 * any internal logic.
 */
function createManualRuntime() {
    let frameCb: (() => void) | null = null;
    const viewportListeners = new Set<() => void>();
    const blurListeners = new Set<() => void>();
    const focusListeners = new Set<() => void>();
    return {
        runtime: {
            scheduleFrame: (cb: () => void) => {
                frameCb = cb;
                return 1;
            },
            cancelFrame: () => {
                frameCb = null;
            },
            subscribeViewportChange: (cb: () => void) => {
                viewportListeners.add(cb);
                return () => viewportListeners.delete(cb);
            },
            subscribeWindowBlur: (cb: () => void) => {
                blurListeners.add(cb);
                return () => blurListeners.delete(cb);
            },
            subscribeWindowFocus: (cb: () => void) => {
                focusListeners.add(cb);
                return () => focusListeners.delete(cb);
            },
        } satisfies DesktopWebViewSurfaceSyncInput['runtime'],
        flushFrame: () => {
            const cb = frameCb;
            frameCb = null;
            cb?.();
        },
        emitViewportChange: () => {
            viewportListeners.forEach((cb) => cb());
        },
        emitWindowBlur: () => {
            blurListeners.forEach((cb) => cb());
        },
        emitWindowFocus: () => {
            focusListeners.forEach((cb) => cb());
        },
    };
}

const RECT_A: DesktopWebViewSurfaceRect = { x: 10, y: 20, width: 640, height: 480, scaleFactor: 1 };
const RECT_B: DesktopWebViewSurfaceRect = { x: 12, y: 24, width: 320, height: 200, scaleFactor: 1 };

async function renderSurfaceSync(input: DesktopWebViewSurfaceSyncInput) {
    return renderHook((props: DesktopWebViewSurfaceSyncInput) => useDesktopWebViewSurfaceSync(props), {
        initialProps: input,
        flushOptions: { cycles: 2, turns: 2 },
    });
}

describe('useDesktopWebViewSurfaceSync', () => {
    it('publishes the measured rect once the frame flushes', async () => {
        const bridge = createBridge();
        const manual = createManualRuntime();
        await renderSurfaceSync({
            bridge,
            commandTarget: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
            active: true,
            measureRect: () => RECT_A,
            runtime: manual.runtime,
        });

        manual.flushFrame();
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(bridge.setBounds).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            visible: true,
            rect: RECT_A,
        });
    });

    it('does not re-issue setBounds when the rect is unchanged across frames (stable-frame early-out)', async () => {
        const bridge = createBridge();
        const manual = createManualRuntime();
        await renderSurfaceSync({
            bridge,
            commandTarget: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
            active: true,
            measureRect: () => RECT_A,
            runtime: manual.runtime,
        });

        manual.flushFrame();
        await flushHookEffects({ cycles: 1, turns: 1 });
        const callsAfterFirst = bridge.setBounds.mock.calls.length;
        expect(callsAfterFirst).toBe(1);

        manual.emitViewportChange();
        manual.flushFrame();
        manual.emitViewportChange();
        manual.flushFrame();
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(bridge.setBounds.mock.calls.length).toBe(callsAfterFirst);
    });

    it('re-issues setBounds when the measured rect changes', async () => {
        const bridge = createBridge();
        const manual = createManualRuntime();
        let rect = RECT_A;
        await renderSurfaceSync({
            bridge,
            commandTarget: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
            active: true,
            measureRect: () => rect,
            runtime: manual.runtime,
        });

        manual.flushFrame();
        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(bridge.setBounds.mock.calls.length).toBe(1);

        rect = RECT_B;
        manual.emitViewportChange();
        manual.flushFrame();
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(bridge.setBounds).toHaveBeenLastCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            visible: true,
            rect: RECT_B,
        });
    });

    it('hides the native view while an occluder overlaps and restores it when clear', async () => {
        const bridge = createBridge();
        const manual = createManualRuntime();
        let occluded = false;
        await renderSurfaceSync({
            bridge,
            commandTarget: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
            active: true,
            measureRect: () => RECT_A,
            occlusionProbe: () => occluded,
            runtime: manual.runtime,
        });

        manual.flushFrame();
        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(bridge.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));

        occluded = true;
        manual.emitViewportChange();
        manual.flushFrame();
        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(bridge.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));

        occluded = false;
        manual.emitViewportChange();
        manual.flushFrame();
        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(bridge.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
    });

    it('toggles pointer passthrough on drag-active and window blur, and restores on end/refocus', async () => {
        const bridge = createBridge();
        const manual = createManualRuntime();
        let dragActive = false;
        const dragListeners = new Set<() => void>();
        await renderSurfaceSync({
            bridge,
            commandTarget: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
            active: true,
            measureRect: () => RECT_A,
            dragSignal: {
                isActive: () => dragActive,
                subscribe: (cb) => {
                    dragListeners.add(cb);
                    return () => dragListeners.delete(cb);
                },
            },
            runtime: manual.runtime,
        });
        await flushHookEffects({ cycles: 1, turns: 1 });
        bridge.setPointerPassthrough.mockClear();

        dragActive = true;
        dragListeners.forEach((cb) => cb());
        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(bridge.setPointerPassthrough).toHaveBeenLastCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            ignore: true,
        });

        dragActive = false;
        dragListeners.forEach((cb) => cb());
        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(bridge.setPointerPassthrough).toHaveBeenLastCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            ignore: false,
        });

        manual.emitWindowBlur();
        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(bridge.setPointerPassthrough).toHaveBeenLastCalledWith(expect.objectContaining({ ignore: true }));

        manual.emitWindowFocus();
        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(bridge.setPointerPassthrough).toHaveBeenLastCalledWith(expect.objectContaining({ ignore: false }));
    });

    it('keeps the native view mounted (hide, no close) on a hidden/parked lifecycle transition', async () => {
        const bridge = createBridge();
        const manual = createManualRuntime();
        const hook = await renderSurfaceSync({
            bridge,
            commandTarget: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
            active: true,
            lifecycleState: 'visible',
            measureRect: () => RECT_A,
            runtime: manual.runtime,
        });
        manual.flushFrame();
        await flushHookEffects({ cycles: 1, turns: 1 });

        await hook.rerender({
            bridge,
            commandTarget: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
            active: true,
            lifecycleState: 'hidden',
            measureRect: () => RECT_A,
            runtime: manual.runtime,
        });
        manual.flushFrame();
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(bridge.closeView).not.toHaveBeenCalled();
        expect(bridge.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
    });

    it('closes the native view on a genuine engine unmount (teardown, not hide)', async () => {
        const bridge = createBridge();
        const manual = createManualRuntime();
        const hook = await renderSurfaceSync({
            bridge,
            commandTarget: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
            active: true,
            lifecycleState: 'visible',
            measureRect: () => RECT_A,
            runtime: manual.runtime,
        });
        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(bridge.closeView).not.toHaveBeenCalled();

        await hook.unmount();

        expect(bridge.closeView).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        });
    });

    it('does not close the native view when a kept-mounted (hidden) engine unmounts', async () => {
        const bridge = createBridge();
        const manual = createManualRuntime();
        const hook = await renderSurfaceSync({
            bridge,
            commandTarget: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
            active: true,
            lifecycleState: 'hidden',
            measureRect: () => RECT_A,
            runtime: manual.runtime,
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        await hook.unmount();

        expect(bridge.closeView).not.toHaveBeenCalled();
    });

    it('closes the native view on a suspended/closed/orphaned lifecycle transition', async () => {
        const bridge = createBridge();
        const manual = createManualRuntime();
        const hook = await renderSurfaceSync({
            bridge,
            commandTarget: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
            active: true,
            lifecycleState: 'visible',
            measureRect: () => RECT_A,
            runtime: manual.runtime,
        });
        manual.flushFrame();
        await flushHookEffects({ cycles: 1, turns: 1 });

        await hook.rerender({
            bridge,
            commandTarget: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
            active: true,
            lifecycleState: 'suspended',
            measureRect: () => RECT_A,
            runtime: manual.runtime,
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(bridge.closeView).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        });
    });
});
