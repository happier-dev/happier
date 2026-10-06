import * as React from 'react';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { Dimensions } from 'react-native';
import type { PluginUiScrollActivityTracker } from '@happier-dev/plugin-ui/advanced';
import { measureInWindow } from '@/components/ui/popover/measure';
import { PAGE_ROW_TOUCH_MIN_HEIGHT_PX } from '@/components/ui/lists/pageRowMetrics';

/**
 * Which widget bodies a scrolling host builds: the one near-viewport rule shared by the Session
 * Board and Home.
 *
 * Opening a surface must not instantiate every widget it holds, so a body outside the window
 * waits and its frame keeps its place. Nothing here is an invented budget: the window is one
 * measured viewport of overscan above the scroll position and two below, and the scroll position
 * is quantized by the host's own minimum item height so a flick advances the window once per item
 * rather than once per frame. Before the host reports its viewport, the window is unknown and
 * every body is eligible (the host supplies the platform window height when it has it).
 */

export type NearViewportWindow = Readonly<{ top: number; bottom: number }>;

/** A body's vertical span in scroll-content coordinates; `height` absent when not yet laid out. */
export type NearViewportSpan = Readonly<{ top: number; height?: number }>;

export function quantizeScrollOffset(offsetY: number, quantum: number): number {
    const step = Math.max(1, quantum);
    return Math.max(0, Math.floor(offsetY / step) * step);
}

export function resolveNearViewportWindow(input: Readonly<{
    /** The quantized scroll offset. */
    windowTopOffset: number;
    viewportHeight: number;
    quantum: number;
    /** Retained presentation uses the visible window instead of widget prebuild overscan. */
    overscan?: boolean;
}>): NearViewportWindow | null {
    if (input.viewportHeight <= 0) return null;
    if (input.overscan === false) return {
        top: input.windowTopOffset,
        bottom: input.windowTopOffset + input.viewportHeight,
    };
    return {
        top: input.windowTopOffset - input.viewportHeight,
        bottom: input.windowTopOffset + Math.max(1, input.quantum) + (input.viewportHeight * 2),
    };
}

/**
 * Whether a body is inside the window. An unmeasured span carries only a lower bound for where it
 * starts, so it is eligible until that bound is below the window.
 */
export function isSpanNearViewport(window: NearViewportWindow | null, span: NearViewportSpan): boolean {
    if (!window) return true;
    if (span.height === undefined) return span.top <= window.bottom;
    return span.top + span.height >= window.top && span.top <= window.bottom;
}

/**
 * A scroll host's window as a tiny external store, for hosts whose items subscribe one by one
 * (Home). The host passes `onScroll`/`onLayout` to its scroll view and never re-renders for them;
 * each item re-renders only when its own eligibility flips.
 */
export type NearViewportTracker = Readonly<{
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    onLayout: (event: LayoutChangeEvent) => void;
    subscribe: (listener: () => void) => () => void;
    getWindow: () => NearViewportWindow | null;
    /** Native/DOM measurements share window coordinates; their delta is content-relative. */
    measureSpan: (node: unknown) => Promise<NearViewportSpan | null>;
    invalidateLayout: () => void;
    getLayoutRevision: () => number;
    onContentSizeChange: (width: number, height: number) => void;
}>;

export function createNearViewportTracker(input: Readonly<{
    quantum: number;
    /** The platform window height, standing in until the scroll view reports its own. */
    initialViewportHeight: number;
    overscan?: boolean;
    /** Canvas horizontal scrolling uses the same window/eligibility policy along its second axis. */
    axis?: 'x' | 'y';
    /** The existing scrolling host's inner content node, not a grid cell or viewport. */
    readContentNode?: () => unknown;
}>): NearViewportTracker {
    let windowTopOffset = 0;
    let viewportHeight = input.initialViewportHeight;
    let window = resolveNearViewportWindow({ windowTopOffset, viewportHeight, quantum: input.quantum, overscan: input.overscan });
    const listeners = new Set<() => void>();
    let layoutRevision = 0;
    let contentWidth = 0;
    let contentHeight = 0;
    const invalidateLayout = () => {
        layoutRevision++;
        for (const listener of [...listeners]) listener();
    };
    const update = (nextTop: number, nextHeight: number) => {
        if (nextTop === windowTopOffset && nextHeight === viewportHeight) return;
        windowTopOffset = nextTop;
        viewportHeight = nextHeight;
        window = resolveNearViewportWindow({ windowTopOffset, viewportHeight, quantum: input.quantum, overscan: input.overscan });
        for (const listener of [...listeners]) listener();
    };
    return {
        onScroll: (event) => update(quantizeScrollOffset(event.nativeEvent.contentOffset[input.axis ?? 'y'], input.quantum), viewportHeight),
        onLayout: (event) => update(windowTopOffset, input.axis === 'x' ? event.nativeEvent.layout.width : event.nativeEvent.layout.height),
        subscribe: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        getWindow: () => window,
        getLayoutRevision: () => layoutRevision,
        invalidateLayout,
        onContentSizeChange: (width, height) => {
            if (width === contentWidth && height === contentHeight) return;
            contentWidth = width; contentHeight = height;
            invalidateLayout();
        },
        measureSpan: async node => {
            const contentNode = input.readContentNode?.();
            if (!node || !contentNode) return null;
            const [rect, content] = await Promise.all([measureInWindow(node), measureInWindow(contentNode)]);
            if (!rect || !content || input.readContentNode?.() !== contentNode) return null;
            return input.axis === 'x' ? { top: rect.x - content.x, height: rect.width }
                : { top: rect.y - content.y, height: rect.height };
        },
    };
}

/**
 * Whether one item's body should be built. `span` is `null` until the item is laid out, and an
 * item a scroll host has never placed waits for that first layout rather than mounting and
 * immediately unmounting far below the fold.
 */
const subscribeWithoutScrollHost = () => () => {};

/** Plugin pages and Project ItemLists attach the incumbent policy to their physical content. */
export function createScrollViewNearViewportTracker(scrollRef: React.RefObject<unknown>, horizontal: boolean): PluginUiScrollActivityTracker {
    const tracker = createNearViewportTracker({
        quantum: PAGE_ROW_TOUCH_MIN_HEIGHT_PX,
        initialViewportHeight: Dimensions.get('window')[horizontal ? 'width' : 'height'],
        axis: horizontal ? 'x' : 'y',
        readContentNode: () => {
            const node = scrollRef.current;
            if (!node || typeof node !== 'object') return null;
            // Native getInnerViewNode returns a numeric handle; measure the host ref itself.
            if ('getInnerViewRef' in node && typeof node.getInnerViewRef === 'function') return node.getInnerViewRef();
            if ('getInnerViewNode' in node && typeof node.getInnerViewNode === 'function') return node.getInnerViewNode();
            return null;
        },
    });
    return { ...tracker, onScroll: event => tracker.onScroll(event as NativeSyntheticEvent<NativeScrollEvent>) };
}

export function useIsNearViewport(tracker: NearViewportTracker | null, span: NearViewportSpan | null): boolean {
    const read = React.useCallback(
        () => tracker === null || (span !== null && isSpanNearViewport(tracker.getWindow(), span)),
        [span, tracker],
    );
    return React.useSyncExternalStore(tracker?.subscribe ?? subscribeWithoutScrollHost, read, read);
}
