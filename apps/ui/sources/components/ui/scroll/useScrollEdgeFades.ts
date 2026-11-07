import * as React from 'react';
import { type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

export type ScrollEdge = 'top' | 'bottom' | 'left' | 'right';

import type { ScrollEdgeVisibility } from '@happier-dev/plugin-ui/presentation';
export type { ScrollEdgeVisibility } from '@happier-dev/plugin-ui/presentation';

export type UseScrollEdgeFadesParams = Readonly<{
    enabledEdges: Partial<Record<ScrollEdge, boolean>>;
    /**
     * Minimum overflow (content - viewport) before we consider scrolling possible.
     * Helps avoid flicker from 0-1px rounding differences.
     */
    overflowThreshold?: number;
    /**
     * Distance from the edge before we show the fade (px).
     */
    edgeThreshold?: number;
    /**
     * Initial visibility state before measurement. Useful for optimistic trailing-edge
     * fades (e.g., bottom: true for lists that typically have more content below).
     */
    initialVisibility?: Partial<ScrollEdgeVisibility>;
    /**
     * Empty space the scroll content keeps after its last item (px). The trailing fade and
     * `canScrollX`/`canScrollY` ignore it, so they clear once the last item is whole; the leading
     * fade still follows the real scroll range, so a rail scrolled less than the inset keeps it.
     */
    contentEndInset?: number;
}>;

type Size = Readonly<{ width: number; height: number }>;
type Offset = Readonly<{ x: number; y: number }>;

const defaultVisibility: ScrollEdgeVisibility = Object.freeze({
    top: false,
    bottom: false,
    left: false,
    right: false,
});

export function useScrollEdgeFades(params: UseScrollEdgeFadesParams) {
    const overflowThreshold = params.overflowThreshold ?? 1;
    const edgeThreshold = params.edgeThreshold ?? 1;
    const endInset = params.contentEndInset ?? 0;

    const initialVisibility = React.useMemo<ScrollEdgeVisibility>(() => {
        return { ...defaultVisibility, ...params.initialVisibility };
    }, [params.initialVisibility]);

    const enabled = React.useMemo(() => {
        return {
            top: Boolean(params.enabledEdges.top),
            bottom: Boolean(params.enabledEdges.bottom),
            left: Boolean(params.enabledEdges.left),
            right: Boolean(params.enabledEdges.right),
        };
    }, [params.enabledEdges.bottom, params.enabledEdges.left, params.enabledEdges.right, params.enabledEdges.top]);

    const viewportRef = React.useRef<Size>({ width: 0, height: 0 });
    const contentRef = React.useRef<Size>({ width: 0, height: 0 });
    const offsetRef = React.useRef<Offset>({ x: 0, y: 0 });

    const [canScroll, setCanScroll] = React.useState(() => ({ x: false, y: false }));

    const visibilityRef = React.useRef<ScrollEdgeVisibility>(initialVisibility);

    const [visibility, setVisibility] = React.useState<ScrollEdgeVisibility>(initialVisibility);

    const recompute = React.useCallback(() => {
        const viewport = viewportRef.current;
        const content = contentRef.current;
        const offset = offsetRef.current;

        const itemsWidth = Math.max(0, content.width - endInset);
        const itemsHeight = Math.max(0, content.height - endInset);
        const canScrollX = itemsWidth > viewport.width + overflowThreshold;
        const canScrollY = itemsHeight > viewport.height + overflowThreshold;
        const scrolledX = content.width > viewport.width + overflowThreshold;
        const scrolledY = content.height > viewport.height + overflowThreshold;

        const top = enabled.top && scrolledY && offset.y > edgeThreshold;
        const bottom =
            enabled.bottom &&
            canScrollY &&
            (offset.y + viewport.height) < (itemsHeight - edgeThreshold);

        const left = enabled.left && scrolledX && offset.x > edgeThreshold;
        const right =
            enabled.right &&
            canScrollX &&
            (offset.x + viewport.width) < (itemsWidth - edgeThreshold);

        const nextVisibility: ScrollEdgeVisibility = { top, bottom, left, right };

        const prevVisibility = visibilityRef.current;
        if (
            prevVisibility.top !== nextVisibility.top ||
            prevVisibility.bottom !== nextVisibility.bottom ||
            prevVisibility.left !== nextVisibility.left ||
            prevVisibility.right !== nextVisibility.right
        ) {
            visibilityRef.current = nextVisibility;
            setVisibility(nextVisibility);
        }

        setCanScroll(prev => {
            if (prev.x === canScrollX && prev.y === canScrollY) return prev;
            return { x: canScrollX, y: canScrollY };
        });
    }, [edgeThreshold, enabled.bottom, enabled.left, enabled.right, enabled.top, endInset, overflowThreshold]);

    const onViewportLayout = React.useCallback((e: LayoutChangeEvent) => {
        const width = e?.nativeEvent?.layout?.width ?? 0;
        const height = e?.nativeEvent?.layout?.height ?? 0;
        viewportRef.current = { width, height };
        recompute();
    }, [recompute]);

    const onContentSizeChange = React.useCallback((width: number, height: number) => {
        contentRef.current = { width, height };
        recompute();
    }, [recompute]);

    const onScroll = React.useCallback((e: Readonly<{ nativeEvent: unknown }>) => {
        // Native ScrollView supplies this platform payload; portable callbacks omit synthetic-event metadata.
        const ne = e?.nativeEvent as NativeScrollEvent | undefined;
        if (!ne) return;

        const x = ne.contentOffset?.x ?? 0;
        const y = ne.contentOffset?.y ?? 0;

        // Prefer event-provided sizes (more accurate during momentum scroll),
        // but keep refs updated too.
        const vw = ne.layoutMeasurement?.width;
        const vh = ne.layoutMeasurement?.height;
        const cw = ne.contentSize?.width;
        const ch = ne.contentSize?.height;

        offsetRef.current = { x, y };

        if (typeof vw === 'number' && typeof vh === 'number') {
            viewportRef.current = { width: vw, height: vh };
        }
        if (typeof cw === 'number' && typeof ch === 'number') {
            contentRef.current = { width: cw, height: ch };
        }

        recompute();
    }, [recompute]);

    // Ensure final position is captured when momentum scroll ends.
    // iOS/Android may not fire a final onScroll event at scroll boundaries.
    const onMomentumScrollEnd = React.useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        const ne = e?.nativeEvent;
        if (!ne) return;

        const x = ne.contentOffset?.x ?? 0;
        const y = ne.contentOffset?.y ?? 0;
        offsetRef.current = { x, y };

        recompute();
    }, [recompute]);

    // One handle until something it reports changes: consumers key effects (DOM listeners, observers) on it.
    return React.useMemo(() => ({
        canScrollX: canScroll.x,
        canScrollY: canScroll.y,
        visibility,
        onViewportLayout,
        onContentSizeChange,
        onScroll,
        onMomentumScrollEnd,
    }) as const, [canScroll.x, canScroll.y, visibility, onViewportLayout, onContentSizeChange, onScroll, onMomentumScrollEnd]);
}
