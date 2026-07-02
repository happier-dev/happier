import * as React from 'react';
import { type LayoutChangeEvent } from 'react-native';

type SelectionListMeasuredPopoverHeightConfig = Readonly<{
    enabled: boolean;
    maxHeight?: number;
    headerExpected: boolean;
    footerExpected: boolean;
    shrinkDelayMs: number;
}>;

type MeasuredSegmentHeights = Readonly<{
    header?: number;
    body?: number;
    footer?: number;
}>;

type SelectionListMeasuredPopoverHeightResult = Readonly<{
    height?: number;
    hidden: boolean;
    onHeaderLayout: (event: LayoutChangeEvent) => void;
    onBodyLayout: (event: LayoutChangeEvent) => void;
    onFooterLayout: (event: LayoutChangeEvent) => void;
}>;

const HEIGHT_EPSILON = 1;

export function useSelectionListMeasuredPopoverHeight(
    config: SelectionListMeasuredPopoverHeightConfig,
): SelectionListMeasuredPopoverHeightResult {
    const boundedMaxHeight = normalizePositiveHeight(config.maxHeight);
    const enabled = config.enabled && boundedMaxHeight !== undefined;
    const [segmentHeights, setSegmentHeights] = React.useState<MeasuredSegmentHeights>({});
    const [height, setHeight] = React.useState<number | undefined>(boundedMaxHeight);
    const [visible, setVisible] = React.useState<boolean>(false);
    const shrinkTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearShrinkTimer = React.useCallback(() => {
        if (shrinkTimerRef.current === null) return;
        clearTimeout(shrinkTimerRef.current);
        shrinkTimerRef.current = null;
    }, []);

    React.useEffect(() => () => {
        clearShrinkTimer();
    }, [clearShrinkTimer]);

    React.useEffect(() => {
        if (!enabled) {
            clearShrinkTimer();
            setVisible(false);
            setHeight(undefined);
            return;
        }
        setHeight((current) => current ?? boundedMaxHeight);
    }, [boundedMaxHeight, clearShrinkTimer, enabled]);

    const targetHeight = React.useMemo(() => {
        if (!enabled || boundedMaxHeight === undefined) return undefined;

        const headerHeight = config.headerExpected ? segmentHeights.header : 0;
        const bodyHeight = segmentHeights.body;
        const footerHeight = config.footerExpected ? segmentHeights.footer : 0;
        if (headerHeight === undefined || bodyHeight === undefined || footerHeight === undefined) {
            return undefined;
        }

        const measuredHeight = headerHeight + bodyHeight + footerHeight;
        if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) return undefined;
        return Math.min(measuredHeight, boundedMaxHeight);
    }, [
        boundedMaxHeight,
        config.footerExpected,
        config.headerExpected,
        enabled,
        segmentHeights.body,
        segmentHeights.footer,
        segmentHeights.header,
    ]);

    React.useEffect(() => {
        if (!enabled || targetHeight === undefined) return;

        setHeight((current) => {
            if (current !== undefined && Math.abs(current - targetHeight) <= HEIGHT_EPSILON) {
                clearShrinkTimer();
                return current;
            }

            if (!visible || current === undefined || targetHeight > current) {
                clearShrinkTimer();
                return targetHeight;
            }

            clearShrinkTimer();
            shrinkTimerRef.current = setTimeout(() => {
                shrinkTimerRef.current = null;
                setHeight((latest) => {
                    if (latest !== undefined && Math.abs(latest - targetHeight) <= HEIGHT_EPSILON) {
                        return latest;
                    }
                    return targetHeight;
                });
            }, config.shrinkDelayMs);
            return current;
        });
        setVisible(true);
    }, [clearShrinkTimer, config.shrinkDelayMs, enabled, targetHeight, visible]);

    const updateSegmentHeight = React.useCallback((segment: keyof MeasuredSegmentHeights, event: LayoutChangeEvent) => {
        const nextHeight = normalizeMeasuredHeight(event.nativeEvent.layout.height);
        if (nextHeight === undefined) return;
        setSegmentHeights((current) => {
            const previous = current[segment];
            if (previous !== undefined && Math.abs(previous - nextHeight) <= HEIGHT_EPSILON) {
                return current;
            }
            return { ...current, [segment]: nextHeight };
        });
    }, []);

    const onHeaderLayout = React.useCallback((event: LayoutChangeEvent) => {
        updateSegmentHeight('header', event);
    }, [updateSegmentHeight]);

    const onBodyLayout = React.useCallback((event: LayoutChangeEvent) => {
        updateSegmentHeight('body', event);
    }, [updateSegmentHeight]);

    const onFooterLayout = React.useCallback((event: LayoutChangeEvent) => {
        updateSegmentHeight('footer', event);
    }, [updateSegmentHeight]);

    return {
        height: enabled ? height ?? boundedMaxHeight : undefined,
        hidden: enabled && !visible,
        onHeaderLayout,
        onBodyLayout,
        onFooterLayout,
    };
}

function normalizePositiveHeight(value: number | undefined): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
    return Math.ceil(value);
}

function normalizeMeasuredHeight(value: number): number | undefined {
    if (!Number.isFinite(value) || value < 0) return undefined;
    return Math.ceil(value);
}
