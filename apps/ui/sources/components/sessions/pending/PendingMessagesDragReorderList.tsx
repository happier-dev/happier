import * as React from 'react';
import { ScrollView, View } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useDerivedValue,
    useSharedValue,
    withSpring,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';

import type { PendingMessage } from '@/sync/domains/state/storageTypes';

import {
    findTargetIndexAtCenterY,
    moveIdToIndex,
    resolveRowDragDisplacementPx,
    resolveRowOffsetPx,
    resolveRowsTotalHeightPx,
} from './pendingMessagesDragReorderGeometry';

export type PendingMessagesDragReorderListProps = Readonly<{
    messages: ReadonlyArray<PendingMessage>;
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

/**
 * The queued messages, reorderable by long-press drag.
 *
 * M1 (2026-08-10) — the rows are in NORMAL FLOW and the block is sized by them. They used to be
 * `position: 'absolute'` inside an `Animated.View` whose height was a shared value recomputed from
 * a per-row height map, with an estimate substituted for any row that had not laid out yet. Three
 * owners of one height, in sequence: the block painted a seed height, then the estimate, then the
 * measurement — a 20.25 -> 92.25 -> 68.25 triple paint on ~2 sends in 12, each step of which is an
 * MVCP scroll adjust in the transcript above it (every observed adjust equalled the block's own
 * height delta, 7/7). Flow layout has ONE owner — the rows — and it is right on the first frame.
 *
 * A drag no longer changes that: the dragged row and the rows it displaces move by TRANSFORM, which
 * carries no layout, so the block's height is the same during a drag as outside one and no row ever
 * needs an estimated height.
 */
export const PendingMessagesDragReorderList = React.memo<PendingMessagesDragReorderListProps>((props) => {
    const longPressMs = typeof props.longPressMs === 'number' && Number.isFinite(props.longPressMs) ? Math.max(0, Math.trunc(props.longPressMs)) : 200;

    // The order the rows are RENDERED in (React children, i.e. flow position). It is a PLAIN value
    // captured by the rows' worklets, not a shared value, because it changes in the same commit as
    // the flow slots it describes: a shared value assigned from an effect would still hold the
    // previous order on the frame that paints the new one, so every row would paint one frame at
    // its full drag displacement on top of its new slot — the double paint this component exists
    // to avoid, moved to the handover.
    const flowIds = React.useMemo(() => props.messages.map((m) => m.id), [props.messages]);
    // The order the in-progress drag has moved them into. Equal to the flow order except during a
    // drag and during the round trip that persists its result, and written from the UI thread.
    const orderedIdsSv = useSharedValue<string[]>(props.messages.map((m) => m.id));
    const heightsSv = useSharedValue<Record<string, number>>({});
    const activeIdSv = useSharedValue<string | null>(null);
    const dragY = useSharedValue(0);
    const startDragY = useSharedValue(0);
    const startScrollOffsetY = useSharedValue(0);
    const scrollOffsetYSv = useSharedValue(0);
    const viewportHeightSv = useSharedValue(0);

    React.useEffect(() => {
        orderedIdsSv.value = flowIds;
    }, [flowIds, orderedIdsSv]);

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

    const scrollToOffset = React.useCallback((y: number) => {
        const value = Math.max(0, Math.trunc(y));
        if (props.onScrollToOffset) {
            props.onScrollToOffset(value);
            return;
        }
        props.scrollRef?.current?.scrollTo({ y: value, animated: false });
    }, [props.onScrollToOffset, props.scrollRef]);

    return (
        <View>
            {props.messages.map((message, index) => (
                <ReorderableRow
                    key={message.id}
                    message={message}
                    index={index}
                    longPressMs={longPressMs}
                    flowIds={flowIds}
                    orderedIdsSv={orderedIdsSv}
                    heightsSv={heightsSv}
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
        </View>
    );
});

type SharedValue<T> = ReturnType<typeof useSharedValue<T>>;

const ReorderableRow = React.memo((props: {
    message: PendingMessage;
    index: number;
    longPressMs: number;
    flowIds: ReadonlyArray<string>;
    orderedIdsSv: SharedValue<string[]>;
    heightsSv: SharedValue<Record<string, number>>;
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
        const heights = props.heightsSv.value;
        const flowOffset = resolveRowOffsetPx(props.flowIds, heights, messageId);
        // `dragY` is a content-space position (it is what the drop target is computed from), so the
        // dragged row's transform is that position relative to the slot it still occupies in flow.
        if (props.activeIdSv.value === messageId) return props.dragY.value - flowOffset;
        const displacementPx = resolveRowDragDisplacementPx({
            flowIds: props.flowIds,
            orderedIds: props.orderedIdsSv.value,
            heights,
            id: messageId,
        });
        // Zero means the rendered order already IS the drag order — the state the queue is in
        // whenever no drag is running, and the state it returns to when the reorder is persisted and
        // the rows re-render in their new positions. Snapping there is what keeps that handover
        // still: springing a transform toward 0 while its flow slot moves by the same amount
        // underneath would paint the motion twice.
        if (displacementPx === 0) return 0;
        return withSpring(displacementPx);
    });

    const animatedStyle = useAnimatedStyle(() => {
        const isDragging = props.activeIdSv.value === messageId;
        return {
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
                props.startDragY.value = resolveRowOffsetPx(props.orderedIdsSv.value, props.heightsSv.value, messageId);
                props.dragY.value = props.startDragY.value;
                props.startScrollOffsetY.value = props.scrollOffsetYSv.value;
            })
            .onUpdate((e) => {
                'worklet';
                const scrollDelta = props.scrollOffsetYSv.value - props.startScrollOffsetY.value;
                props.dragY.value = props.startDragY.value + e.translationY + scrollDelta;

                const heights = props.heightsSv.value;
                const heightPx = heights[messageId] ?? 0;
                const centerY = props.dragY.value + heightPx / 2;

                const order = props.orderedIdsSv.value;
                const targetIndex = findTargetIndexAtCenterY(order, heights, centerY);
                const next = moveIdToIndex(order, messageId, targetIndex);
                if (next.join('|') !== order.join('|')) {
                    props.orderedIdsSv.value = next;
                }

                const viewportHeightPx = props.viewportHeightSv.value;
                if (viewportHeightPx > 0) {
                    const maxScroll = Math.max(0, resolveRowsTotalHeightPx(order, heights) - viewportHeightPx);
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
        props.heightsSv,
        props.longPressMs,
        props.onReorderIds,
        props.orderedIdsSv,
        props.scrollOffsetYSv,
        props.scrollToOffset,
        props.startDragY,
        props.startScrollOffsetY,
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
                    // Recorded as measured: this height decides drop targets and the auto-scroll
                    // bound, never a painted position, so the `Math.ceil` that used to quantise it
                    // (when it WAS the row's absolute offset) has nothing left to protect.
                    props.heightsSv.value = { ...props.heightsSv.value, [messageId]: h };
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
