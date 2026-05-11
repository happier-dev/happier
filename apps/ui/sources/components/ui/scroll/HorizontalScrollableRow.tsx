import * as React from 'react';
import {
    Platform,
    ScrollView,
    View,
    type LayoutChangeEvent,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
    type ViewStyle,
} from 'react-native';

import { ScrollEdgeFades } from './ScrollEdgeFades';
import { ScrollEdgeIndicators } from './ScrollEdgeIndicators';
import { useScrollEdgeFades } from './useScrollEdgeFades';

const HORIZONTAL_SCROLL_END_GUTTER_WIDTH = 24;

const ScrollViewWithWheel = ScrollView as unknown as React.ComponentType<
    React.ComponentPropsWithRef<typeof ScrollView> & {
        onWheel?: any;
    }
>;

export type HorizontalScrollableRowProps = Readonly<{
    children: React.ReactNode;
    fadeColor: string;
    indicatorColor: string;
    testID?: string;
    contentTestID?: string;
    containerStyle?: ViewStyle;
    contentStyle?: ViewStyle;
    fadeLeftStyle?: ViewStyle;
    fadeRightStyle?: ViewStyle;
}>;

export function HorizontalScrollableRow(props: HorizontalScrollableRowProps) {
    const fades = useScrollEdgeFades({
        enabledEdges: { left: true, right: true },
        overflowThreshold: 8,
        edgeThreshold: 2,
    });
    const scrollRef = React.useRef<any>(null);

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
        fades.onContentSizeChange(
            Math.max(0, scrollWidth - HORIZONTAL_SCROLL_END_GUTTER_WIDTH),
            clientHeight ?? 0,
        );
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
                contentSize: {
                    width: Math.max(0, scrollWidth - HORIZONTAL_SCROLL_END_GUTTER_WIDTH),
                    height: clientHeight,
                },
                zoomScale: 1,
            },
        } as unknown as NativeSyntheticEvent<NativeScrollEvent>;
        fades.onScroll(scrollEvent);
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

        const ResizeObserverAny = (globalThis as any).ResizeObserver as
            | (new (cb: () => void) => { observe: (value: any) => void; disconnect: () => void })
            | undefined;
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

    const canScroll = fades.canScrollX;
    const showFadeLeft = canScroll && fades.visibility.left;
    const showFadeRight = canScroll && fades.visibility.right;

    return (
        <View style={[{ position: 'relative' }, props.containerStyle]}>
            <ScrollViewWithWheel
                ref={scrollRef}
                testID={props.testID}
                horizontal
                showsHorizontalScrollIndicator={false}
                scrollEnabled
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
                onLayout={fades.onViewportLayout}
                onContentSizeChange={(width: number, height: number) => {
                    fades.onContentSizeChange(
                        Math.max(0, width - HORIZONTAL_SCROLL_END_GUTTER_WIDTH),
                        height,
                    );
                }}
                onScroll={(event: any) => {
                    if (Platform.OS === 'web') {
                        if (getScrollNode()) {
                            reportWebScroll();
                        } else {
                            fades.onScroll(event);
                        }
                        return;
                    }
                    const nativeEvent = event?.nativeEvent;
                    const contentSizeWidth = nativeEvent?.contentSize?.width;
                    if (typeof contentSizeWidth !== 'number') {
                        fades.onScroll(event);
                        return;
                    }
                    fades.onScroll({
                        ...event,
                        nativeEvent: {
                            ...nativeEvent,
                            contentSize: {
                                ...nativeEvent.contentSize,
                                width: Math.max(0, contentSizeWidth - HORIZONTAL_SCROLL_END_GUTTER_WIDTH),
                            },
                        },
                    });
                }}
                scrollEventThrottle={16}
            >
                <View testID={props.contentTestID} style={props.contentStyle}>
                    {props.children}
                </View>
            </ScrollViewWithWheel>
            <ScrollEdgeFades
                color={props.fadeColor}
                size={24}
                edges={{ left: showFadeLeft, right: showFadeRight }}
                leftStyle={props.fadeLeftStyle}
                rightStyle={props.fadeRightStyle}
            />
            <ScrollEdgeIndicators
                edges={{ left: showFadeLeft, right: showFadeRight }}
                color={props.indicatorColor}
                size={14}
                opacity={0.28}
                leftStyle={props.fadeLeftStyle}
                rightStyle={props.fadeRightStyle}
            />
        </View>
    );
}
