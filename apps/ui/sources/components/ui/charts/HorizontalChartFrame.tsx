import * as React from 'react';
import { ScrollView, View, useWindowDimensions, type ScrollViewProps, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';

import {
    resolveHorizontalChartInitialOffset,
    resolveHorizontalChartTrailingPad,
    resolveHorizontalChartViewportWidth,
} from './resolveHorizontalChartInitialOffset';

type HorizontalChartFrameProps = Readonly<{
    children: React.ReactNode;
    contentWidth: number;
    viewportInset?: number;
    style?: StyleProp<ViewStyle>;
    scrollViewProps?: Partial<ScrollViewProps>;
    /**
     * Floating `‹`/`›` scroll chevrons at the overflowing edges. On by default
     * for wide flow charts; the banner/heatmap turns it OFF (D-R4-2) — the soft
     * edge fade is a cleaner affordance there than a chevron that floats over
     * the card edge.
     */
    showEdgeIndicators?: boolean;
    /**
     * Column stride (cell + gap) for grids with left-anchored per-column labels
     * (the heatmap month row). When set, the end-anchor snaps to a column
     * boundary so the leftmost visible column's label is never left-clipped
     * (C-3); a matching trailing pad keeps the newest column fully visible.
     */
    columnStride?: number;
    /**
     * Insets the top of the left/right edge fades by this many px so a grid's
     * label axis (the heatmap month row) is never dimmed — the fade then applies
     * to the CELLS only, while label partials are handled deterministically by
     * culling (see `useHorizontalChartViewport`).
     */
    edgeFadeInsetTop?: number;
}>;

const styles = StyleSheet.create(() => ({
    frame: {
        position: 'relative',
        overflow: 'hidden',
    },
}));

/**
 * The frame's resolved end-anchor geometry, exposed to children so a grid can
 * decide per-column what is fully visible from the SAME offset/stride math the
 * frame owns (e.g. the heatmap culls any month label whose week-column starts
 * left of the first fully-visible column — no partial "Sep"→"ep" label at any
 * width, C-3). `visibleLeft` is the end-anchored scroll offset (content x at the
 * viewport's left edge).
 */
export type HorizontalChartViewport = Readonly<{ contentWidth: number; viewportWidth: number; visibleLeft: number }>;

const HorizontalChartViewportContext = React.createContext<HorizontalChartViewport | null>(null);

export function useHorizontalChartViewport(): HorizontalChartViewport | null {
    return React.useContext(HorizontalChartViewportContext);
}

export function HorizontalChartFrame(props: HorizontalChartFrameProps): React.ReactElement {
    const {
        children,
        contentWidth,
        viewportInset = 104,
        style,
        scrollViewProps,
        showEdgeIndicators = true,
        columnStride,
        edgeFadeInsetTop,
    } = props;
    const { width } = useWindowDimensions();
    const { theme } = useUnistyles();
    const scrollRef = React.useRef<ScrollView>(null);
    const appliedInitialOffsetKeyRef = React.useRef<string | null>(null);
    // The window estimate is only valid until the frame measures itself: in a
    // modal/panel the real viewport is far narrower than the window, and an
    // under-estimated overflow leaves the newest (right-edge) columns clipped
    // off-screen (D-R3-1). The measured width re-anchors to the true end.
    const [measuredWidth, setMeasuredWidth] = React.useState<number | null>(null);
    const viewportWidth = resolveHorizontalChartViewportWidth({
        windowWidth: width,
        viewportInset,
        measuredWidth,
    });
    const initialOffset = resolveHorizontalChartInitialOffset({
        contentWidth,
        viewportWidth,
        columnStride,
    });
    // Trailing pad that lets the end-anchor snap to a column boundary (C-3)
    // while keeping the newest column fully visible on the right.
    const trailingPad = resolveHorizontalChartTrailingPad({
        contentWidth,
        viewportWidth,
        columnStride,
    });
    const initialOffsetKey = `${contentWidth}:${viewportWidth}:${initialOffset}`;
    // Expose the resolved end-anchor geometry to children (label-culling grids).
    const viewport = React.useMemo<HorizontalChartViewport>(
        () => ({ contentWidth, viewportWidth, visibleLeft: initialOffset }),
        [contentWidth, viewportWidth, initialOffset],
    );
    const edgeFadeInsetStyle = edgeFadeInsetTop != null ? { top: edgeFadeInsetTop } : undefined;
    const fades = useScrollEdgeFades({
        enabledEdges: { left: true, right: true },
        overflowThreshold: 1,
        edgeThreshold: 8,
        initialVisibility: {
            left: initialOffset > 0,
            right: false,
        },
    });

    const applyInitialOffset = React.useCallback(() => {
        if (initialOffset <= 0) {
            appliedInitialOffsetKeyRef.current = initialOffsetKey;
            return;
        }
        if (appliedInitialOffsetKeyRef.current === initialOffsetKey) {
            return;
        }

        scrollRef.current?.scrollTo({ x: initialOffset, y: 0, animated: false });
        appliedInitialOffsetKeyRef.current = initialOffsetKey;
    }, [initialOffset, initialOffsetKey]);

    React.useEffect(() => {
        applyInitialOffset();
    }, [applyInitialOffset]);

    const handleViewportLayout = React.useCallback((event: Parameters<typeof fades.onViewportLayout>[0]) => {
        fades.onViewportLayout(event);
        const layoutWidth = event.nativeEvent.layout.width;
        if (layoutWidth > 0) {
            setMeasuredWidth((current) => (current === layoutWidth ? current : layoutWidth));
        }
        applyInitialOffset();
    }, [applyInitialOffset, fades]);

    const handleContentSizeChange = React.useCallback((contentWidthValue: number, contentHeightValue: number) => {
        fades.onContentSizeChange(contentWidthValue, contentHeightValue);
        applyInitialOffset();
    }, [applyInitialOffset, fades]);

    return (
        <View style={[styles.frame, style]} onLayout={handleViewportLayout}>
            <ScrollView
                ref={scrollRef}
                horizontal
                showsHorizontalScrollIndicator={false}
                scrollEventThrottle={16}
                onContentSizeChange={handleContentSizeChange}
                onScroll={fades.onScroll}
                onMomentumScrollEnd={fades.onMomentumScrollEnd}
                {...scrollViewProps}
                contentContainerStyle={trailingPad > 0
                    ? [scrollViewProps?.contentContainerStyle, { paddingRight: trailingPad }]
                    : scrollViewProps?.contentContainerStyle}
            >
                <HorizontalChartViewportContext.Provider value={viewport}>
                    {children}
                </HorizontalChartViewportContext.Provider>
            </ScrollView>
            <ScrollEdgeFades
                color={theme.colors.surface.base}
                size={20}
                edges={fades.visibility}
                leftStyle={edgeFadeInsetStyle}
                rightStyle={edgeFadeInsetStyle}
            />
            {showEdgeIndicators ? (
                <ScrollEdgeIndicators
                    color={theme.colors.text.secondary}
                    size={14}
                    opacity={0.45}
                    edges={fades.visibility}
                    leftStyle={{ width: 18 }}
                    rightStyle={{ width: 18 }}
                />
            ) : null}
        </View>
    );
}
