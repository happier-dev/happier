import * as React from 'react';
import { Platform, ScrollView, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, View } from 'react-native';

import { HAPPIER_FOCUS_RING_V1 } from '@happier-dev/plugin-ui/presentation';

import { HorizontalScrollEdgeMask } from '@/components/ui/scroll/HorizontalScrollEdgeMask';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import {
    resolveHorizontalScrollEdgeMaskRamps,
    resolveHorizontalScrollEdgeMaskStyle,
} from '@/components/ui/scroll/resolveScrollEdgeMaskStyle';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { t } from '@/text';

import { attachActionBarMouseDragScroll } from './attachActionBarMouseDragScroll';
import { attachChipRailReveal } from './attachChipRailReveal';
import { resolveChipRailCutEdges, resolveChipRailSnapOffsets, type ChipRailCutEdges } from './resolveChipRailCutEdges';

const ACTION_BAR_SCROLL_END_GUTTER_WIDTH = 24;
/**
 * The rail scrolls, so it clips: it reaches out by the focus ring's extent and pads its chips back
 * in place, so a focused chip's ring is drawn whole (web, where keyboard focus paints the ring).
 */
const FOCUS_RING_EXTENT = HAPPIER_FOCUS_RING_V1.widthPx + HAPPIER_FOCUS_RING_V1.gapPx;
const WEB_RING_ROOM_STYLE = { margin: -FOCUS_RING_EXTENT, padding: FOCUS_RING_EXTENT } as const;
const WEB_CONTAINER_UNCLIPPED_STYLE = { overflow: 'visible' } as const;

const ScrollViewWithWheel = ScrollView as unknown as React.ComponentType<
    React.ComponentPropsWithRef<typeof ScrollView> & {
        onWheel?: any;
        onKeyDown?: (event: unknown) => void;
        tabIndex?: number;
    }
>;

function readKeyboardKey(event: unknown): string | null {
    if (!event || typeof event !== 'object') return null;
    const candidate = event as Readonly<{ key?: unknown; nativeEvent?: Readonly<{ key?: unknown }> }>;
    const key = candidate.nativeEvent?.key ?? candidate.key;
    return typeof key === 'string' ? key : null;
}

/**
 * The rail's chips: the first level at or below `host` that holds more than one element. Web hands the
 * scroll node's content; native hands its content view, whose element tree (React Native's DOM node
 * API) has the same shape.
 */
function railItemElements(host: any): any[] {
    while (host && host.children?.length === 1) host = host.firstElementChild;
    if (!host?.children) return [];
    return Array.from(host.children as ArrayLike<any>).filter((item) => item.getBoundingClientRect().width > 0);
}

/** Item edges relative to the visible rail: `originLeft` is the rail's left edge in the same space. */
function measureChipRailCutEdges(input: Readonly<{ itemsHost: any; originLeft: number; viewportWidth: number; scrollLeft: number }>): ChipRailCutEdges {
    return resolveChipRailCutEdges({
        viewportWidth: input.viewportWidth,
        scrollLeft: input.scrollLeft,
        items: railItemElements(input.itemsHost).map((item) => {
            const rect = item.getBoundingClientRect();
            return { left: Math.round(rect.left - input.originLeft), right: Math.round(rect.right - input.originLeft) };
        }),
    });
}

function sameChipRailCutEdges(a: ChipRailCutEdges, b: ChipRailCutEdges): boolean {
    return a.start?.clearUntilPx === b.start?.clearUntilPx && a.start?.solidFromPx === b.start?.solidFromPx
        && a.end?.solidUntilPx === b.end?.solidUntilPx && a.end?.clearFromPx === b.end?.clearFromPx;
}

function composerRailControls(node: any): any[] {
    if (!node || typeof node.querySelectorAll !== 'function') return [];
    return Array.from(node.querySelectorAll('button,[role="button"],[role="switch"]'));
}

export type AgentInputScrollableChipRowProps = Readonly<{
    children: React.ReactNode;
    indicatorColor: string;
    containerStyle?: any;
    contentStyle?: any;
    fadeLeftStyle?: any;
    fadeRightStyle?: any;
}>;

export function AgentInputScrollableChipRow(props: AgentInputScrollableChipRowProps) {
    const fades = useScrollEdgeFades({
        enabledEdges: { left: true, right: true },
        overflowThreshold: 8,
        edgeThreshold: 2,
        contentEndInset: ACTION_BAR_SCROLL_END_GUTTER_WIDTH,
    });
    const scrollRef = React.useRef<any>(null);
    // Where each scrolled edge ends between two chips, so a rail shows whole chips (the edge mask).
    const [cutEdges, setCutEdges] = React.useState<ChipRailCutEdges>({});
    // Native: the content view whose children are the chips, the rail's offset and its visible width.
    const contentRef = React.useRef<any>(null);
    const nativeScrollXRef = React.useRef(0);
    const [nativeViewportWidth, setNativeViewportWidth] = React.useState(0);
    const nativeViewportWidthRef = React.useRef(0);
    // Native: where a scroll comes to rest, read from the same chip edges the mask measures.
    const [snapOffsets, setSnapOffsets] = React.useState<number[] | undefined>(undefined);

    const reportNativeCutEdges = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        const content = contentRef.current;
        if (!content || typeof content.getBoundingClientRect !== 'function') return;
        // Item rects and the content's own rect move together with the scroll, so their difference is
        // the content position; the offset turns it into a position in the visible rail.
        const next = measureChipRailCutEdges({
            itemsHost: content,
            originLeft: content.getBoundingClientRect().left + nativeScrollXRef.current,
            viewportWidth: nativeViewportWidthRef.current,
            scrollLeft: nativeScrollXRef.current,
        });
        setCutEdges((previous) => (sameChipRailCutEdges(previous, next) ? previous : next));
        const contentRect = content.getBoundingClientRect();
        const offsets = resolveChipRailSnapOffsets({
            viewportWidth: nativeViewportWidthRef.current,
            contentWidth: contentRect.width,
            items: railItemElements(content).map((item) => {
                const itemRect = item.getBoundingClientRect();
                return { left: itemRect.left - contentRect.left, right: itemRect.right - contentRect.left };
            }),
        });
        setSnapOffsets((previous) => {
            const resolved = offsets.length > 0 ? offsets : undefined;
            const same = previous === resolved || (previous && resolved && previous.length === resolved.length
                && previous.every((offset, index) => offset === resolved[index]));
            return same ? previous : resolved;
        });
    }, []);

    const getScrollNode = React.useCallback(() => {
        const raw = scrollRef.current;
        if (!raw) return null;
        return raw.getScrollableNode?.() ?? raw;
    }, []);

    const seedScrollMeasurements = React.useCallback(() => {
        if (Platform.OS !== 'web') return;
        const node = getScrollNode() as any;
        if (!node) return;
        const clientWidth = typeof node.clientWidth === 'number' ? node.clientWidth : null;
        const clientHeight = typeof node.clientHeight === 'number' ? node.clientHeight : null;
        const scrollWidth = typeof node.scrollWidth === 'number' ? node.scrollWidth : null;
        if (clientWidth === null || scrollWidth === null) return;

        const layoutEvent = {
            nativeEvent: { layout: { x: 0, y: 0, width: clientWidth, height: clientHeight ?? 0 } },
        } as unknown as LayoutChangeEvent;
        fades.onViewportLayout(layoutEvent);
        fades.onContentSizeChange(scrollWidth, clientHeight ?? 0);
    }, [fades, getScrollNode]);

    const reportWebScroll = React.useCallback((nodeOverride?: any) => {
        if (Platform.OS !== 'web') return;
        const node = (nodeOverride ?? getScrollNode()) as any;
        if (!node) return;

        const clientWidth = typeof node.clientWidth === 'number' ? node.clientWidth : null;
        const clientHeight = typeof node.clientHeight === 'number' ? node.clientHeight : 0;
        const scrollWidth = typeof node.scrollWidth === 'number' ? node.scrollWidth : null;
        const scrollLeft = typeof node.scrollLeft === 'number' ? node.scrollLeft : 0;
        if (clientWidth === null || scrollWidth === null) return;

        const scrollEvent = {
            nativeEvent: {
                contentInset: { top: 0, left: 0, bottom: 0, right: 0 },
                contentOffset: { x: scrollLeft, y: 0 },
                layoutMeasurement: { width: clientWidth, height: clientHeight },
                contentSize: { width: scrollWidth, height: clientHeight },
                zoomScale: 1,
            },
        } as unknown as NativeSyntheticEvent<NativeScrollEvent>;
        fades.onScroll(scrollEvent);
        const next = measureChipRailCutEdges({
            itemsHost: node.firstElementChild,
            originLeft: node.getBoundingClientRect().left,
            viewportWidth: node.clientWidth,
            scrollLeft: node.scrollLeft ?? 0,
        });
        setCutEdges((previous) => (sameChipRailCutEdges(previous, next) ? previous : next));
    }, [fades, getScrollNode]);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;

        const requestAnimationFrameSafe: (cb: () => void) => any =
            (globalThis as any).requestAnimationFrame?.bind(globalThis) ??
            ((cb: () => void) => setTimeout(cb, 0));
        const cancelAnimationFrameSafe: (id: any) => void =
            (globalThis as any).cancelAnimationFrame?.bind(globalThis) ??
            ((id: any) => clearTimeout(id));

        const animationFrameId = requestAnimationFrameSafe(() => {
            seedScrollMeasurements();
            reportWebScroll();
        });

        const node = getScrollNode();
        if (!node) return () => cancelAnimationFrameSafe(animationFrameId);

        const ResizeObserverAny = (globalThis as any).ResizeObserver as (new (cb: () => void) => { observe: (value: any) => void; disconnect: () => void }) | undefined;
        if (typeof ResizeObserverAny === 'function') {
            const observer = new ResizeObserverAny(() => {
                seedScrollMeasurements();
                reportWebScroll();
            });
            observer.observe(node as any);
            return () => {
                cancelAnimationFrameSafe(animationFrameId);
                observer.disconnect();
            };
        }

        const onResize = () => {
            seedScrollMeasurements();
            reportWebScroll();
        };
        const windowObject = (globalThis as any).window as Window | undefined;
        windowObject?.addEventListener?.('resize', onResize);
        return () => {
            cancelAnimationFrameSafe(animationFrameId);
            windowObject?.removeEventListener?.('resize', onResize);
        };
    }, [getScrollNode, reportWebScroll, seedScrollMeasurements]);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;

        const requestAnimationFrameSafe: (cb: () => void) => any =
            (globalThis as any).requestAnimationFrame?.bind(globalThis) ??
            ((cb: () => void) => setTimeout(cb, 0));
        const cancelAnimationFrameSafe: (id: any) => void =
            (globalThis as any).cancelAnimationFrame?.bind(globalThis) ??
            ((id: any) => clearTimeout(id));

        let cleanup: (() => void) | undefined;
        const animationFrameId = requestAnimationFrameSafe(() => {
            const node = getScrollNode() as any;
            if (!node || typeof node.addEventListener !== 'function') return;
            const detachDrag = attachActionBarMouseDragScroll({
                node,
                onScroll: () => reportWebScroll(node),
            });
            const detachReveal = attachChipRailReveal({ node, onScroll: () => reportWebScroll(node) });
            cleanup = () => { detachDrag(); detachReveal(); };
        });

        return () => {
            cancelAnimationFrameSafe(animationFrameId);
            cleanup?.();
        };
    }, [getScrollNode, reportWebScroll]);

    // The hook already ignores the end gutter for the trailing edge and follows the real scroll range
    // for the leading one, so a rail scrolled by less than the gutter still fades its cut chip.
    const showFadeLeft = fades.visibility.left;
    const showFadeRight = fades.visibility.right;
    const canScroll = fades.canScrollX || showFadeLeft || showFadeRight;
    const edgeMaskOptions = React.useMemo(
        () => ({ fadeSize: 24, ...(cutEdges.start ? { startClip: cutEdges.start } : {}), ...(cutEdges.end ? { endClip: cutEdges.end } : {}) }),
        [cutEdges],
    );
    const edgeVisibility = React.useMemo(
        () => ({ top: false, bottom: false, left: showFadeLeft, right: showFadeRight }),
        [showFadeLeft, showFadeRight],
    );
    const webEdgeMask = React.useMemo(
        () => (Platform.OS === 'web' ? [WEB_RING_ROOM_STYLE, resolveHorizontalScrollEdgeMaskStyle(edgeVisibility, edgeMaskOptions)] : undefined),
        [edgeMaskOptions, edgeVisibility],
    );
    const nativeEdgeRamps = React.useMemo(
        () => (Platform.OS === 'web' ? null : resolveHorizontalScrollEdgeMaskRamps(edgeVisibility, edgeMaskOptions)),
        [edgeMaskOptions, edgeVisibility],
    );
    const handleViewportLayout = React.useCallback((event: LayoutChangeEvent) => {
        fades.onViewportLayout(event);
        if (Platform.OS === 'web') return;
        const width = event.nativeEvent.layout.width;
        nativeViewportWidthRef.current = width;
        setNativeViewportWidth(width);
        reportNativeCutEdges();
    }, [fades, reportNativeCutEdges]);

    const handleKeyDown = React.useCallback((event: unknown) => {
        if (Platform.OS !== 'web') return;
        const key = readKeyboardKey(event);
        if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
        const node = getScrollNode() as any;
        const controls = composerRailControls(node);
        if (controls.length === 0) return;
        const active = (globalThis as any).document?.activeElement;
        const currentIndex = controls.indexOf(active);
        const nextIndex = key === 'Home'
            ? 0
            : key === 'End'
                ? controls.length - 1
                : key === 'ArrowLeft'
                    ? Math.max(0, currentIndex < 0 ? controls.length - 1 : currentIndex - 1)
                    : Math.min(controls.length - 1, currentIndex < 0 ? 0 : currentIndex + 1);
        // Focus reveals the control and its neighbours (`attachChipRailReveal`).
        controls[nextIndex]?.focus?.();
        (event as any)?.preventDefault?.();
        (event as any)?.stopPropagation?.();
    }, [getScrollNode]);

    const rail = (
            <ScrollViewWithWheel
                ref={scrollRef}
                // The chips fade out at a scrollable edge through a mask on the rail itself (web: a CSS
                // mask; native: `HorizontalScrollEdgeMask` below). The composer's glass surface is
                // translucent, so a painted fade has no colour to paint and the last chip read as cut off.
                style={webEdgeMask}
                horizontal
                accessibilityRole="toolbar"
                accessibilityLabel={t('agentInput.chipRail.accessibilityLabel')}
                accessibilityHint={canScroll ? t('agentInput.chipRail.moreControlsHint') : undefined}
                tabIndex={0}
                onKeyDown={handleKeyDown}
                showsHorizontalScrollIndicator={false}
                scrollEnabled
                decelerationRate="fast"
                snapToOffsets={snapOffsets}
                alwaysBounceHorizontal={false}
                directionalLockEnabled
                keyboardShouldPersistTaps="handled"
                onWheel={(event: any) => {
                    if (Platform.OS !== 'web') return;
                    const node = getScrollNode() as any;
                    if (!node) return;
                    const nativeEvent = event?.nativeEvent ?? event;
                    const deltaX = typeof nativeEvent?.deltaX === 'number' ? nativeEvent.deltaX : 0;
                    const deltaY = typeof nativeEvent?.deltaY === 'number' ? nativeEvent.deltaY : 0;
                    const delta = Math.abs(deltaY) >= Math.abs(deltaX) ? deltaY : deltaX;
                    if (!delta) return;
                    const before = node.scrollLeft ?? 0;
                    node.scrollLeft = before + delta;
                    reportWebScroll(node);
                }}
                onLayout={handleViewportLayout}
                onContentSizeChange={(width, height) => {
                    fades.onContentSizeChange(width, height);
                    if (Platform.OS === 'web') reportWebScroll();
                    else reportNativeCutEdges();
                }}
                onScroll={(event: any) => {
                    // Web reports its DOM scroll itself (`attachChipRailReveal`).
                    if (Platform.OS === 'web') return;
                    fades.onScroll(event);
                    nativeScrollXRef.current = event?.nativeEvent?.contentOffset?.x ?? 0;
                    reportNativeCutEdges();
                }}
                scrollEventThrottle={16}
            >
                <View ref={contentRef} style={props.contentStyle}>
                    {props.children}
                </View>
            </ScrollViewWithWheel>
    );

    return (
        <View style={Platform.OS === 'web' ? [props.containerStyle, WEB_CONTAINER_UNCLIPPED_STYLE] : props.containerStyle}>
            {/* Only an overflowing rail has an edge to mask. The wrapper changes with overflow alone, never
                while scrolling, so the rail never remounts mid-gesture. */}
            {Platform.OS !== 'web' && fades.canScrollX
                ? <HorizontalScrollEdgeMask ramps={nativeEdgeRamps} width={nativeViewportWidth}>{rail}</HorizontalScrollEdgeMask>
                : rail}
            <ScrollEdgeIndicators
                edges={{ left: showFadeLeft, right: showFadeRight }}
                color={props.indicatorColor}
                size={14}
                // The only sign that more chips wait beyond the edge, so it reads as a control, not a watermark.
                opacity={0.6}
                leftStyle={props.fadeLeftStyle}
                rightStyle={props.fadeRightStyle}
            />
        </View>
    );
}
