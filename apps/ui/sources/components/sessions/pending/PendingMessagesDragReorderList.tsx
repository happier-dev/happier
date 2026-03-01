import * as React from 'react';
import { ScrollView, View } from 'react-native';
import Animated, {
    useAnimatedReaction,
    useAnimatedStyle,
    useDerivedValue,
    useSharedValue,
    withSpring,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';

import type { PendingMessage } from '@/sync/domains/state/storageTypes';

export type PendingMessagesDragReorderListProps = Readonly<{
    messages: ReadonlyArray<PendingMessage>;
    estimatedRowHeightPx: number;
    longPressMs?: number;
    scrollRef?: React.RefObject<ScrollView | null>;
    onScrollToOffset?: ((y: number) => void) | null;
    viewportHeightPx?: number | null;
    scrollOffsetY?: number | null;
    onReorderIds?: ((ids: string[]) => void) | null;
    renderItem: (args: {
        message: PendingMessage;
        index: number;
        isDragging: boolean;
        renderDragHandle: (args: Readonly<{ children: React.ReactNode; testID?: string; accessibilityLabel?: string }>) => React.ReactNode;
    }) => React.ReactNode;
}>;

function clamp(value: number, min: number, max: number): number {
    'worklet';
    return Math.max(min, Math.min(max, value));
}

function computeOffsets(
    orderedIds: ReadonlyArray<string>,
    heights: Record<string, number>,
    estimatedRowHeightPx: number,
) {
    'worklet';
    const offsets: Record<string, number> = {};
    let y = 0;
    for (const id of orderedIds) {
        offsets[id] = y;
        const h = heights[id];
        y += typeof h === 'number' && Number.isFinite(h) && h > 0 ? h : estimatedRowHeightPx;
    }
    return { offsets, totalHeightPx: y };
}

function findTargetIndexAtCenterY(
    orderedIds: ReadonlyArray<string>,
    heights: Record<string, number>,
    estimatedRowHeightPx: number,
    centerY: number,
): number {
    'worklet';
    let y = 0;
    for (let i = 0; i < orderedIds.length; i += 1) {
        const id = orderedIds[i]!;
        const h = heights[id];
        const heightPx = typeof h === 'number' && Number.isFinite(h) && h > 0 ? h : estimatedRowHeightPx;
        const midpoint = y + heightPx / 2;
        if (centerY < midpoint) return i;
        y += heightPx;
    }
    return orderedIds.length - 1;
}

function moveIdToIndex(orderedIds: ReadonlyArray<string>, id: string, nextIndex: number): string[] {
    'worklet';
    const currentIndex = orderedIds.indexOf(id);
    if (currentIndex < 0) return orderedIds.slice();
    if (currentIndex === nextIndex) return orderedIds.slice();
    const next = orderedIds.slice();
    next.splice(currentIndex, 1);
    next.splice(nextIndex, 0, id);
    return next;
}

export const PendingMessagesDragReorderList = React.memo<PendingMessagesDragReorderListProps>((props) => {
    const estimatedRowHeightPx = Math.max(24, Math.trunc(props.estimatedRowHeightPx));
    const longPressMs = typeof props.longPressMs === 'number' && Number.isFinite(props.longPressMs) ? Math.max(0, Math.trunc(props.longPressMs)) : 200;

    const orderedIdsSv = useSharedValue<string[]>(props.messages.map((m) => m.id));
    const heightsSv = useSharedValue<Record<string, number>>({});
    const offsetsSv = useSharedValue<Record<string, number>>({});
    const totalHeightSv = useSharedValue(0);
    const activeIdSv = useSharedValue<string | null>(null);
    const dragY = useSharedValue(0);
    const startDragY = useSharedValue(0);
    const startScrollOffsetY = useSharedValue(0);
    const scrollOffsetYSv = useSharedValue(0);
    const viewportHeightSv = useSharedValue(0);

    React.useEffect(() => {
        orderedIdsSv.value = props.messages.map((m) => m.id);
    }, [props.messages, orderedIdsSv]);

    React.useEffect(() => {
        if (typeof props.scrollOffsetY === 'number' && Number.isFinite(props.scrollOffsetY)) {
            scrollOffsetYSv.value = Math.max(0, Math.trunc(props.scrollOffsetY));
        }
    }, [props.scrollOffsetY, scrollOffsetYSv]);

    React.useEffect(() => {
        if (typeof props.viewportHeightPx === 'number' && Number.isFinite(props.viewportHeightPx)) {
            viewportHeightSv.value = Math.max(0, Math.trunc(props.viewportHeightPx));
        }
    }, [props.viewportHeightPx, viewportHeightSv]);

    useAnimatedReaction(
        () => ({ order: orderedIdsSv.value, heights: heightsSv.value }),
        ({ order, heights }) => {
            const computed = computeOffsets(order, heights, estimatedRowHeightPx);
            offsetsSv.value = computed.offsets;
            totalHeightSv.value = computed.totalHeightPx;
        },
        [estimatedRowHeightPx],
    );

    const containerStyle = useAnimatedStyle(() => {
        return { height: totalHeightSv.value };
    });

    const scrollToOffset = React.useCallback((y: number) => {
        const value = Math.max(0, Math.trunc(y));
        if (props.onScrollToOffset) {
            props.onScrollToOffset(value);
            return;
        }
        props.scrollRef?.current?.scrollTo({ y: value, animated: false });
    }, [props.onScrollToOffset, props.scrollRef]);

    return (
        <Animated.View style={containerStyle}>
            {props.messages.map((message, index) => (
                <ReorderableRow
                    key={message.id}
                    message={message}
                    index={index}
                    estimatedRowHeightPx={estimatedRowHeightPx}
                    longPressMs={longPressMs}
                    orderedIdsSv={orderedIdsSv}
                    heightsSv={heightsSv}
                    offsetsSv={offsetsSv}
                    totalHeightSv={totalHeightSv}
                    activeIdSv={activeIdSv}
                    dragY={dragY}
                    startDragY={startDragY}
                    scrollOffsetYSv={scrollOffsetYSv}
                    startScrollOffsetY={startScrollOffsetY}
                    viewportHeightSv={viewportHeightSv}
                    scrollToOffset={scrollToOffset}
                    onReorderIds={props.onReorderIds}
                    renderItem={props.renderItem}
                />
            ))}
        </Animated.View>
    );
});

type SharedValue<T> = ReturnType<typeof useSharedValue<T>>;

const ReorderableRow = React.memo((props: {
    message: PendingMessage;
    index: number;
    estimatedRowHeightPx: number;
    longPressMs: number;
    orderedIdsSv: SharedValue<string[]>;
    heightsSv: SharedValue<Record<string, number>>;
    offsetsSv: SharedValue<Record<string, number>>;
    totalHeightSv: SharedValue<number>;
    activeIdSv: SharedValue<string | null>;
    dragY: SharedValue<number>;
    startDragY: SharedValue<number>;
    scrollOffsetYSv: SharedValue<number>;
    startScrollOffsetY: SharedValue<number>;
    viewportHeightSv: SharedValue<number>;
    scrollToOffset: (y: number) => void;
    onReorderIds?: ((ids: string[]) => void) | null;
    renderItem: PendingMessagesDragReorderListProps['renderItem'];
}) => {
    const messageId = props.message.id;

    const translateY = useDerivedValue(() => {
        const offset = props.offsetsSv.value[messageId] ?? 0;
        if (props.activeIdSv.value === messageId) return props.dragY.value;
        return withSpring(offset);
    });

    const animatedStyle = useAnimatedStyle(() => {
        const isDragging = props.activeIdSv.value === messageId;
        return {
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            transform: [{ translateY: translateY.value }, { scale: isDragging ? 1.02 : 1 }],
            zIndex: isDragging ? 1000 : 0,
        };
    });

    const pan = React.useMemo(() => {
        return Gesture.Pan()
            .activateAfterLongPress(props.longPressMs)
            .onStart(() => {
                'worklet';
                props.activeIdSv.value = messageId;
                props.startDragY.value = props.offsetsSv.value[messageId] ?? 0;
                props.dragY.value = props.startDragY.value;
                props.startScrollOffsetY.value = props.scrollOffsetYSv.value;
            })
            .onUpdate((e) => {
                'worklet';
                const scrollDelta = props.scrollOffsetYSv.value - props.startScrollOffsetY.value;
                props.dragY.value = props.startDragY.value + e.translationY + scrollDelta;

                const heightPx = props.heightsSv.value[messageId] ?? props.estimatedRowHeightPx;
                const centerY = props.dragY.value + heightPx / 2;

                const order = props.orderedIdsSv.value;
                const targetIndex = findTargetIndexAtCenterY(order, props.heightsSv.value, props.estimatedRowHeightPx, centerY);
                const next = moveIdToIndex(order, messageId, targetIndex);
                if (next.join('|') !== order.join('|')) {
                    props.orderedIdsSv.value = next;
                }

                const viewportHeightPx = props.viewportHeightSv.value;
                if (viewportHeightPx > 0) {
                    const maxScroll = Math.max(0, props.totalHeightSv.value - viewportHeightPx);
                    const localY = centerY - props.scrollOffsetYSv.value;
                    const edgeThreshold = 44;
                    const step = 14;
                    if (localY < edgeThreshold) {
                        const nextScroll = clamp(props.scrollOffsetYSv.value - step, 0, maxScroll);
                        if (nextScroll !== props.scrollOffsetYSv.value) {
                            props.scrollOffsetYSv.value = nextScroll;
                            scheduleOnRN(props.scrollToOffset, nextScroll);
                        }
                    } else if (localY > viewportHeightPx - edgeThreshold) {
                        const nextScroll = clamp(props.scrollOffsetYSv.value + step, 0, maxScroll);
                        if (nextScroll !== props.scrollOffsetYSv.value) {
                            props.scrollOffsetYSv.value = nextScroll;
                            scheduleOnRN(props.scrollToOffset, nextScroll);
                        }
                    }
                }
            })
            .onEnd(() => {
                'worklet';
                const ids = props.orderedIdsSv.value.slice();
                props.activeIdSv.value = null;
                if (props.onReorderIds) {
                    scheduleOnRN(props.onReorderIds, ids);
                }
            })
            .onFinalize(() => {
                'worklet';
                props.activeIdSv.value = null;
            });
    }, [
        messageId,
        props.activeIdSv,
        props.dragY,
        props.estimatedRowHeightPx,
        props.heightsSv,
        props.longPressMs,
        props.offsetsSv,
        props.onReorderIds,
        props.orderedIdsSv,
        props.scrollOffsetYSv,
        props.scrollToOffset,
        props.startDragY,
        props.startScrollOffsetY,
        props.totalHeightSv,
        props.viewportHeightSv,
    ]);

    const renderDragHandle = React.useCallback((args: Readonly<{ children: React.ReactNode; testID?: string; accessibilityLabel?: string }>) => {
        return (
            <GestureDetector gesture={pan}>
                <View testID={args.testID} accessibilityRole="button" accessibilityLabel={args.accessibilityLabel}>
                    {args.children}
                </View>
            </GestureDetector>
        );
    }, [pan]);

    const isDragging = false;

    return (
        <Animated.View style={animatedStyle}>
            <View
                onLayout={(e) => {
                    const h = e.nativeEvent.layout.height;
                    if (!Number.isFinite(h) || h <= 0) return;
                    props.heightsSv.value = { ...props.heightsSv.value, [messageId]: Math.ceil(h) };
                }}
            >
                {props.renderItem({
                    message: props.message,
                    index: props.index,
                    isDragging,
                    renderDragHandle,
                })}
            </View>
        </Animated.View>
    );
});
