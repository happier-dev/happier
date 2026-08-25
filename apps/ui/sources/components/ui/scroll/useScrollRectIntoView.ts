import * as React from 'react';
import type { ScrollView } from 'react-native';

type NativeLayoutEvent = Readonly<{
    nativeEvent?: Readonly<{
        layout?: Readonly<{
            y?: number;
            height?: number;
        }>;
    }>;
}>;

type NativeScrollEvent = Readonly<{
    nativeEvent?: Readonly<{
        contentOffset?: Readonly<{ y?: number }>;
        layoutMeasurement?: Readonly<{ height?: number }>;
        contentSize?: Readonly<{ height?: number }>;
    }>;
}>;

export type ScrollItemLayoutHandler = (event: NativeLayoutEvent) => void;

export type ScrollRectIntoViewRegistry = Readonly<{
    scrollRef: React.RefObject<ScrollView | null>;
    registerItemLayout: (key: string) => ScrollItemLayoutHandler;
    onViewportLayout: (event: NativeLayoutEvent) => void;
    onContentSizeChange: (width: number, height: number) => void;
    onScroll: (event: NativeScrollEvent) => void;
}>;

type ScrollRect = Readonly<{
    y: number;
    height: number;
}>;

type ScrollMetrics = Readonly<{
    offsetY: number;
    viewportHeight: number;
    contentHeight: number;
}>;

export function resolveScrollOffsetForVisibleRect(params: Readonly<{
    rect: ScrollRect;
    metrics: ScrollMetrics;
    padding?: number;
    alignment?: 'nearest' | 'center';
}>): number | null {
    const padding = Math.max(0, params.padding ?? 8);
    const alignment = params.alignment ?? 'nearest';
    const currentOffset = Math.max(0, params.metrics.offsetY);
    const viewportHeight = Math.max(0, params.metrics.viewportHeight);
    const contentHeight = Math.max(0, params.metrics.contentHeight);
    if (viewportHeight <= 0) return null;

    const rectTop = params.rect.y;
    const rectBottom = params.rect.y + Math.max(0, params.rect.height);
    const visibleTop = currentOffset + padding;
    const visibleBottom = currentOffset + viewportHeight - padding;
    const maxOffset = Math.max(0, contentHeight - viewportHeight);

    const topAlignedOffset = Math.max(0, Math.min(maxOffset, rectTop - padding));
    // A target taller than the viewport cannot be centred: doing so puts its
    // own start — the thing the caller asked to reveal — above the top edge.
    // Show the start instead. Targets that fit are centred exactly as before.
    const centeredOffset = rectBottom - rectTop > viewportHeight
        ? topAlignedOffset
        : Math.max(
            0,
            Math.min(maxOffset, rectTop + ((rectBottom - rectTop) / 2) - (viewportHeight / 2)),
        );

    if (rectTop < visibleTop) {
        return alignment === 'center' ? centeredOffset : topAlignedOffset;
    }
    if (rectBottom > visibleBottom) {
        return alignment === 'center'
            ? centeredOffset
            : Math.max(0, Math.min(maxOffset, rectBottom - viewportHeight + padding));
    }
    return null;
}

function readLayout(event: NativeLayoutEvent): ScrollRect | null {
    const layout = event.nativeEvent?.layout;
    const y = layout?.y;
    const height = layout?.height;
    if (typeof y !== 'number' || typeof height !== 'number') return null;
    return { y, height };
}

export function useScrollRectIntoViewRegistry(params: Readonly<{
    activeKey: string | null;
    padding?: number;
    alignment?: 'nearest' | 'center';
    animated?: boolean;
    once?: boolean;
}>): ScrollRectIntoViewRegistry {
    const scrollRef = React.useRef<ScrollView | null>(null);
    const itemLayoutsRef = React.useRef(new Map<string, ScrollRect>());
    const activeKeyRef = React.useRef<string | null>(params.activeKey);
    const metricsRef = React.useRef<ScrollMetrics>({
        offsetY: 0,
        viewportHeight: 0,
        contentHeight: 0,
    });
    const settledActiveKeyRef = React.useRef<string | null>(null);
    const [revision, setRevision] = React.useState(0);

    const bumpRevision = React.useCallback(() => {
        setRevision((value) => value + 1);
    }, []);

    const ensureActiveItemVisible = React.useCallback(() => {
        const activeKey = activeKeyRef.current;
        if (!activeKey) return;
        if (params.once === true && settledActiveKeyRef.current === activeKey) return;
        const rect = itemLayoutsRef.current.get(activeKey);
        if (!rect) return;
        if (metricsRef.current.viewportHeight <= 0 || metricsRef.current.contentHeight <= 0) return;
        const nextOffset = resolveScrollOffsetForVisibleRect({
            rect,
            metrics: metricsRef.current,
            padding: params.padding,
            alignment: params.alignment,
        });
        if (nextOffset === null) return;
        const scrollView = scrollRef.current;
        if (!scrollView?.scrollTo) return;
        scrollView.scrollTo({
            y: nextOffset,
            animated: params.animated ?? true,
        });
        if (params.once === true) {
            settledActiveKeyRef.current = activeKey;
        }
    }, [params.alignment, params.animated, params.once, params.padding]);

    const registerItemLayout = React.useCallback((key: string): ScrollItemLayoutHandler => {
        return (event) => {
            const layout = readLayout(event);
            if (!layout) return;
            const previous = itemLayoutsRef.current.get(key);
            if (previous?.y === layout.y && previous.height === layout.height) return;
            itemLayoutsRef.current.set(key, layout);
            bumpRevision();
            ensureActiveItemVisible();
        };
    }, [bumpRevision, ensureActiveItemVisible]);

    const onViewportLayout = React.useCallback((event: NativeLayoutEvent) => {
        const height = event.nativeEvent?.layout?.height;
        if (typeof height !== 'number') return;
        if (metricsRef.current.viewportHeight === height) return;
        metricsRef.current = { ...metricsRef.current, viewportHeight: height };
        bumpRevision();
        ensureActiveItemVisible();
    }, [bumpRevision, ensureActiveItemVisible]);

    const onContentSizeChange = React.useCallback((_width: number, height: number) => {
        if (metricsRef.current.contentHeight === height) return;
        metricsRef.current = { ...metricsRef.current, contentHeight: height };
        bumpRevision();
        ensureActiveItemVisible();
    }, [bumpRevision, ensureActiveItemVisible]);

    const onScroll = React.useCallback((event: NativeScrollEvent) => {
        const offsetY = event.nativeEvent?.contentOffset?.y;
        const viewportHeight = event.nativeEvent?.layoutMeasurement?.height;
        const contentHeight = event.nativeEvent?.contentSize?.height;
        metricsRef.current = {
            offsetY: typeof offsetY === 'number' ? offsetY : metricsRef.current.offsetY,
            viewportHeight: typeof viewportHeight === 'number' ? viewportHeight : metricsRef.current.viewportHeight,
            contentHeight: typeof contentHeight === 'number' ? contentHeight : metricsRef.current.contentHeight,
        };
    }, []);

    React.useEffect(() => {
        activeKeyRef.current = params.activeKey;
        if (params.activeKey === null) {
            settledActiveKeyRef.current = null;
        }
        ensureActiveItemVisible();
    }, [ensureActiveItemVisible, params.activeKey, revision]);

    return {
        scrollRef,
        registerItemLayout,
        onViewportLayout,
        onContentSizeChange,
        onScroll,
    };
}
