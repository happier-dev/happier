import * as React from 'react';
import { Platform, View } from 'react-native';
import Animated, { type SharedValue, useAnimatedStyle, useDerivedValue, useSharedValue, withSpring } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';
import { StyleSheet } from 'react-native-unistyles';

import type { Session } from '@/sync/domains/state/storageTypes';
import { SessionItem } from './SessionItem';

export type SessionGroupRowModel = Readonly<{
    key: string;
    session: Session;
    subtitle?: string | null;
    serverId?: string;
    serverName?: string;
    showServerBadge: boolean;
    pinned: boolean;
    onTogglePinned?: (() => void) | null;
    tags?: string[];
    allKnownTags?: string[];
    onSetTags?: ((newTags: string[]) => void) | null;
    tagsEnabled?: boolean;
    selected?: boolean;
    variant?: 'default' | 'no-path';
}>;

export type SessionGroupDragListProps = Readonly<{
    groupKey: string;
    rows: ReadonlyArray<SessionGroupRowModel>;
    compact: boolean;
    compactMinimal?: boolean;
    onReorderKeys?: ((keys: string[]) => void) | null;
}>;

const ROW_HEIGHT_DEFAULT = 88;
const ROW_HEIGHT_COMPACT = 72;
const ROW_HEIGHT_MINIMAL = 52;

function getPosition(index: number, rowHeight: number) {
    'worklet';
    return index * rowHeight;
}

function getOrder(y: number, rowHeight: number) {
    'worklet';
    return Math.round(y / rowHeight);
}

function buildOrderedKeys(positions: Record<string, number>): string[] {
    'worklet';
    const entries = Object.keys(positions).map((key) => [key, positions[key] ?? 0] as const);
    entries.sort((a, b) => a[1] - b[1]);
    return entries.map((e) => e[0]);
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        marginHorizontal: 16,
        marginBottom: 12,
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface,
        position: 'relative',
    },
}));

type ReorderableRowProps = Readonly<{
    row: SessionGroupRowModel;
    index: number;
    rowHeight: number;
    totalItems: number;
    positions: SharedValue<Record<string, number>>;
    onReorderKeys?: ((keys: string[]) => void) | null;
    compact: boolean;
    compactMinimal?: boolean;
}>;

const ReorderableRow = React.memo<ReorderableRowProps>((props) => {
    const isDragging = useSharedValue(false);
    const dragY = useSharedValue(0);
    const startDragY = useSharedValue(0);
    const scale = useSharedValue(1);
    const zIndex = useSharedValue(0);

    const position = useDerivedValue(() => {
        return props.positions.value[props.row.key] ?? props.index;
    });

    const translateY = useDerivedValue(() => {
        if (isDragging.value) return dragY.value;
        return withSpring(getPosition(position.value, props.rowHeight));
    });

    const panGesture = Gesture.Pan()
        .activateAfterLongPress(Platform.OS === 'web' ? 200 : 500)
        .onStart(() => {
            'worklet';
            isDragging.value = true;
            const current = getPosition(position.value, props.rowHeight);
            startDragY.value = current;
            dragY.value = current;
            scale.value = withSpring(1.03);
            zIndex.value = 1000;
        })
        .onUpdate((e) => {
            'worklet';
            dragY.value = startDragY.value + e.translationY;
            const newOrder = getOrder(dragY.value, props.rowHeight);
            const currentOrder = position.value;
            if (newOrder === currentOrder) return;
            if (newOrder < 0 || newOrder >= props.totalItems) return;

            const next = Object.assign({}, props.positions.value);
            for (const key in next) {
                const pos = next[key];
                if (newOrder > currentOrder) {
                    if (pos > currentOrder && pos <= newOrder) next[key] = pos - 1;
                } else {
                    if (pos < currentOrder && pos >= newOrder) next[key] = pos + 1;
                }
            }
            next[props.row.key] = newOrder;
            props.positions.value = next;
        })
        .onEnd(() => {
            'worklet';
            isDragging.value = false;
            scale.value = withSpring(1);
            zIndex.value = withSpring(0);
            if (!props.onReorderKeys) return;
            const orderedKeys = buildOrderedKeys(props.positions.value);
            scheduleOnRN(props.onReorderKeys, orderedKeys);
        })
        .onFinalize(() => {
            'worklet';
            isDragging.value = false;
            scale.value = withSpring(1);
            zIndex.value = withSpring(0);
        });

    const animatedStyle = useAnimatedStyle(() => {
        return {
            transform: [{ translateY: translateY.value }, { scale: scale.value }],
            zIndex: zIndex.value,
        };
    });

    return (
        <GestureDetector gesture={panGesture}>
            <Animated.View
                style={[
                    {
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                    },
                    animatedStyle,
                ]}
            >
                <SessionItem
                    embedded={true}
                    embeddedIsLast={props.index === props.totalItems - 1}
                    session={props.row.session}
                    subtitleOverride={props.row.subtitle ?? null}
                    serverId={props.row.serverId}
                    serverName={props.row.serverName}
                    showServerBadge={props.row.showServerBadge}
                    pinned={props.row.pinned}
                    onTogglePinned={props.row.onTogglePinned}
                    tags={props.row.tags}
                    allKnownTags={props.row.allKnownTags}
                    onSetTags={props.row.onSetTags}
                    tagsEnabled={props.row.tagsEnabled}
                    selected={props.row.selected}
                    variant={props.row.variant}
                    compact={props.compact}
                    compactMinimal={props.compactMinimal}
                />
            </Animated.View>
        </GestureDetector>
    );
});

export const SessionGroupDragList = React.memo<SessionGroupDragListProps>((props) => {
    const styles = stylesheet;
    const rowHeight = props.compactMinimal
        ? ROW_HEIGHT_MINIMAL
        : props.compact
            ? ROW_HEIGHT_COMPACT
            : ROW_HEIGHT_DEFAULT;
    const positions = useSharedValue<Record<string, number>>({});

    React.useEffect(() => {
        const next: Record<string, number> = {};
        props.rows.forEach((row, index) => {
            next[row.key] = index;
        });
        positions.value = next;
    }, [props.rows]);

    const totalHeight = rowHeight * props.rows.length;

    return (
        <View style={[styles.container, { height: totalHeight }]}>
            {props.rows.map((row, index) => (
                <ReorderableRow
                    key={row.key}
                    row={row}
                    index={index}
                    rowHeight={rowHeight}
                    totalItems={props.rows.length}
                    positions={positions}
                    onReorderKeys={props.onReorderKeys}
                    compact={props.compact}
                    compactMinimal={props.compactMinimal}
                />
            ))}
        </View>
    );
});
