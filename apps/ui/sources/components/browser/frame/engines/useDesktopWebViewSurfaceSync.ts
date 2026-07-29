import * as React from 'react';

import type {
    DesktopBrowserBoundsRect,
    DesktopBrowserCommandResult,
} from '@/sync/domains/browser/adapters/desktopWebViewBridge';
import type { BrowserSurfaceLifecycleState } from '@/components/browser/surfaces/browserSurfaceLifecycle';

export type DesktopWebViewSurfaceRect = DesktopBrowserBoundsRect;

/**
 * The native-bridge surface this hook drives. It is the interaction subset of the engine bridge:
 * bounds (position + visibility), pointer passthrough (host hit-testing), and close. The hook never
 * touches navigation/devtools/page-info — those stay owned by the engine's open/navigate effects.
 */
export type DesktopWebViewSurfaceSyncBridge = Readonly<{
    setBounds: (request: Readonly<{
        browserSessionId: string;
        viewId: string;
        visible: boolean;
        rect: DesktopWebViewSurfaceRect;
    }>) => Promise<DesktopBrowserCommandResult>;
    setPointerPassthrough: (request: Readonly<{
        browserSessionId: string;
        viewId: string;
        ignore: boolean;
    }>) => Promise<DesktopBrowserCommandResult>;
    closeView: (request: Readonly<{
        browserSessionId: string;
        viewId: string;
    }>) => Promise<DesktopBrowserCommandResult>;
}>;

export type DesktopWebViewSurfaceCommandTarget = Readonly<{
    browserSessionId: string;
    viewId: string;
}>;

/**
 * A host-side drag/resize signal. `isActive()` is the current pressed state of a pane/sidebar
 * resize handle (or an HTML drag); `subscribe` notifies when it flips. Sourced from the host's
 * existing resize-interaction state where one exists; absent off-desktop or when no resize affordance
 * overlaps the preview.
 */
export type DesktopWebViewDragSignal = Readonly<{
    isActive: () => boolean;
    subscribe: (listener: () => void) => () => void;
}>;

/**
 * Injectable system boundaries (rAF + viewport-change + window focus/blur). Defaults bind to the real
 * `globalThis`/`window` on desktop and degrade to no-ops off-desktop. Tests pass a hand-driven runtime
 * so the decision logic is exercised deterministically without a DOM.
 */
export type DesktopWebViewSurfaceSyncRuntime = Readonly<{
    scheduleFrame: (callback: () => void) => unknown;
    cancelFrame: (handle: unknown) => void;
    subscribeViewportChange: (listener: () => void) => () => void;
    subscribeWindowBlur: (listener: () => void) => () => void;
    subscribeWindowFocus: (listener: () => void) => () => void;
}>;

export type DesktopWebViewSurfaceSyncInput = Readonly<{
    bridge: DesktopWebViewSurfaceSyncBridge;
    commandTarget: DesktopWebViewSurfaceCommandTarget;
    /** Whether the engine currently owns a live native view (URL resolved, open succeeded). */
    active: boolean;
    /**
     * The browser-surface lifecycle state the host computes. `hidden`/`parked` keep the native view
     * mounted (hide, no close); `suspended`/`closed`/`orphaned` close it; `visible`/undefined keep it
     * shown. Plumbed by the tab/split-canvas owner (FP-BRW-TABS-1); when absent the view stays shown
     * and is torn down only on a genuine engine unmount.
     */
    lifecycleState?: BrowserSurfaceLifecycleState;
    /** Measures the placeholder rect in window space; returns null when not yet measurable. */
    measureRect: () => DesktopWebViewSurfaceRect | null;
    /** Host-overlay sample-point hit-test: true when an @/modal or Popover overlaps the preview rect. */
    occlusionProbe?: () => boolean;
    /** Pane/sidebar resize-drag signal; passthrough is engaged while it is active. */
    dragSignal?: DesktopWebViewDragSignal;
    runtime?: DesktopWebViewSurfaceSyncRuntime;
}>;

function rectEquals(a: DesktopWebViewSurfaceRect, b: DesktopWebViewSurfaceRect): boolean {
    return a.x === b.x
        && a.y === b.y
        && a.width === b.width
        && a.height === b.height
        && a.scaleFactor === b.scaleFactor;
}

function rectIsPaintable(rect: DesktopWebViewSurfaceRect): boolean {
    return rect.width > 0 && rect.height > 0;
}

/**
 * Lifecycle states that keep the native view mounted but hidden (tab/pane switched away). The view is
 * retained so a return shows the same page with no reload flash.
 */
function lifecycleHidesWithoutClosing(state: BrowserSurfaceLifecycleState | undefined): boolean {
    return state === 'hidden' || state === 'parked';
}

/**
 * Lifecycle states that tear the native view down (logical view suspended/closed, or its host slot
 * was lost). These are the only lifecycle transitions that call `closeView`.
 */
function lifecycleClosesView(state: BrowserSurfaceLifecycleState | undefined): boolean {
    return state === 'suspended' || state === 'closed' || state === 'orphaned';
}

const NOOP = () => {};

function resolveDefaultRuntime(): DesktopWebViewSurfaceSyncRuntime {
    const globalAny = globalThis as Record<string, unknown> & {
        requestAnimationFrame?: (cb: FrameRequestCallback) => number;
        cancelAnimationFrame?: (handle: number) => void;
        ResizeObserver?: new (cb: () => void) => { observe: (target: unknown) => void; disconnect: () => void };
        addEventListener?: (type: string, listener: () => void) => void;
        removeEventListener?: (type: string, listener: () => void) => void;
    };
    const windowObject = (globalAny.window ?? globalAny) as typeof globalAny;

    const scheduleFrame = typeof globalAny.requestAnimationFrame === 'function'
        ? (cb: () => void) => globalAny.requestAnimationFrame!(cb)
        : (cb: () => void) => setTimeout(cb, 0) as unknown as number;
    const cancelFrame = typeof globalAny.cancelAnimationFrame === 'function'
        ? (handle: unknown) => globalAny.cancelAnimationFrame!(handle as number)
        : (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>);

    const subscribeWindowEvent = (type: string) => (listener: () => void): (() => void) => {
        if (typeof windowObject.addEventListener !== 'function') {
            return NOOP;
        }
        windowObject.addEventListener(type, listener);
        return () => {
            windowObject.removeEventListener?.(type, listener);
        };
    };

    return {
        scheduleFrame,
        cancelFrame,
        // Window-resize is the durable cross-runtime viewport-change source; the engine additionally
        // pumps a frame on transition/reflow via the explicit `requestSync` path it owns.
        subscribeViewportChange: subscribeWindowEvent('resize'),
        subscribeWindowBlur: subscribeWindowEvent('blur'),
        subscribeWindowFocus: subscribeWindowEvent('focus'),
    };
}

export type DesktopWebViewSurfaceSyncController = Readonly<{
    /** Request a bounds resync on the next frame (e.g. from the engine's onLayout/transition hooks). */
    requestSync: () => void;
}>;

/**
 * Single host-side owner of desktop WebView interaction continuity: rAF-throttled occlusion-aware
 * bounds sync (with a stable-frame early-out), pointer-passthrough during drag/blur, and keep-mounted
 * lifecycle handling. The engine wires this in place of its old one-shot `onLayout` push, and the
 * tab/split-canvas owner (FP-BRW-TABS-1) feeds the lifecycle/occlusion/drag inputs from one place for
 * both desktop and mobile.
 */
export function useDesktopWebViewSurfaceSync(
    input: DesktopWebViewSurfaceSyncInput,
): DesktopWebViewSurfaceSyncController {
    const { bridge, commandTarget, active } = input;
    const runtime = React.useMemo(() => input.runtime ?? resolveDefaultRuntime(), [input.runtime]);

    const measureRectRef = React.useRef(input.measureRect);
    measureRectRef.current = input.measureRect;
    const occlusionProbeRef = React.useRef(input.occlusionProbe);
    occlusionProbeRef.current = input.occlusionProbe;

    const lastPublishedRectRef = React.useRef<DesktopWebViewSurfaceRect | null>(null);
    const lastPublishedVisibleRef = React.useRef<boolean | null>(null);
    const frameHandleRef = React.useRef<unknown>(null);
    const passthroughEngagedRef = React.useRef(false);

    // Keep-mounted: latch a hide once the lifecycle parks the view so the rAF loop keeps it hidden
    // (visible:false) without churning IPC, and so a final unmount that follows a hide does not close.
    const lifecycleHiddenRef = React.useRef(lifecycleHidesWithoutClosing(input.lifecycleState));
    lifecycleHiddenRef.current = lifecycleHidesWithoutClosing(input.lifecycleState);

    const publishBounds = React.useCallback((rect: DesktopWebViewSurfaceRect, visible: boolean) => {
        const last = lastPublishedRectRef.current;
        if (last && lastPublishedVisibleRef.current === visible && rectEquals(last, rect)) {
            return;
        }
        lastPublishedRectRef.current = rect;
        lastPublishedVisibleRef.current = visible;
        void bridge.setBounds({
            browserSessionId: commandTarget.browserSessionId,
            viewId: commandTarget.viewId,
            visible,
            rect,
        });
    }, [bridge, commandTarget.browserSessionId, commandTarget.viewId]);

    const runSyncFrame = React.useCallback(() => {
        frameHandleRef.current = null;
        if (!active) {
            return;
        }
        const rect = measureRectRef.current();
        if (!rect) {
            return;
        }
        const occluded = occlusionProbeRef.current?.() === true;
        const hiddenByLifecycle = lifecycleHiddenRef.current;
        const visible = rectIsPaintable(rect) && !occluded && !hiddenByLifecycle;
        publishBounds(rect, visible);
    }, [active, publishBounds]);
    const runSyncFrameRef = React.useRef(runSyncFrame);
    runSyncFrameRef.current = runSyncFrame;

    const requestSync = React.useCallback(() => {
        if (frameHandleRef.current != null) {
            return;
        }
        frameHandleRef.current = runtime.scheduleFrame(() => {
            runSyncFrameRef.current();
        });
    }, [runtime]);
    const requestSyncRef = React.useRef(requestSync);
    requestSyncRef.current = requestSync;

    // Drive the bounds sync from viewport changes (resize/reflow) + an initial frame, with the
    // stable-frame early-out inside `publishBounds` suppressing redundant IPC while idle.
    React.useEffect(() => {
        if (!active) {
            return undefined;
        }
        requestSyncRef.current();
        const unsubscribe = runtime.subscribeViewportChange(() => {
            requestSyncRef.current();
        });
        return () => {
            unsubscribe();
            if (frameHandleRef.current != null) {
                runtime.cancelFrame(frameHandleRef.current);
                frameHandleRef.current = null;
            }
        };
    }, [active, runtime]);

    // Re-evaluate visibility whenever the lifecycle/occlusion/drag inputs change identity.
    React.useEffect(() => {
        if (!active) {
            return;
        }
        requestSyncRef.current();
    }, [active, input.lifecycleState, input.occlusionProbe]);

    const setPassthrough = React.useCallback((ignore: boolean) => {
        if (passthroughEngagedRef.current === ignore) {
            return;
        }
        passthroughEngagedRef.current = ignore;
        void bridge.setPointerPassthrough({
            browserSessionId: commandTarget.browserSessionId,
            viewId: commandTarget.viewId,
            ignore,
        });
    }, [bridge, commandTarget.browserSessionId, commandTarget.viewId]);
    const setPassthroughRef = React.useRef(setPassthrough);
    setPassthroughRef.current = setPassthrough;

    // Pointer passthrough: engage while a resize-drag is active OR the window is blurred (so the page
    // never swallows a host gesture / a click that should land on another app), restore otherwise.
    const dragSignal = input.dragSignal;
    React.useEffect(() => {
        if (!active) {
            setPassthroughRef.current(false);
            return undefined;
        }
        let windowBlurred = false;
        const evaluate = () => {
            const dragging = dragSignal?.isActive() === true;
            setPassthroughRef.current(dragging || windowBlurred);
        };
        const unsubscribeDrag = dragSignal?.subscribe(evaluate) ?? NOOP;
        const unsubscribeBlur = runtime.subscribeWindowBlur(() => {
            windowBlurred = true;
            evaluate();
        });
        const unsubscribeFocus = runtime.subscribeWindowFocus(() => {
            windowBlurred = false;
            evaluate();
        });
        evaluate();
        return () => {
            unsubscribeDrag();
            unsubscribeBlur();
            unsubscribeFocus();
        };
    }, [active, dragSignal, runtime]);

    // Keep-mounted lifecycle: close ONLY on suspended/closed/orphaned. A hidden/parked transition
    // hides the view (handled by the rAF loop via `lifecycleHiddenRef`) and never closes it.
    const lifecycleState = input.lifecycleState;
    const closeNativeView = React.useCallback(() => {
        lastPublishedRectRef.current = null;
        lastPublishedVisibleRef.current = null;
        passthroughEngagedRef.current = false;
        void bridge.closeView({
            browserSessionId: commandTarget.browserSessionId,
            viewId: commandTarget.viewId,
        });
    }, [bridge, commandTarget.browserSessionId, commandTarget.viewId]);
    const closeNativeViewRef = React.useRef(closeNativeView);
    closeNativeViewRef.current = closeNativeView;

    React.useEffect(() => {
        if (lifecycleClosesView(lifecycleState)) {
            closeNativeViewRef.current();
        }
    }, [lifecycleState]);

    // Genuine engine teardown: close the native view on final unmount UNLESS the view is being kept
    // mounted across a hide (the tab/split-canvas owner keeps the engine mounted on hide, so an
    // unmount that is not hide-latched is a real teardown — not a tab switch). This is the only
    // unmount-driven close, and it never fires for a hidden/parked lifecycle.
    React.useEffect(() => () => {
        if (!lifecycleHiddenRef.current) {
            closeNativeViewRef.current();
        }
    }, []);

    return React.useMemo(() => ({ requestSync }), [requestSync]);
}
