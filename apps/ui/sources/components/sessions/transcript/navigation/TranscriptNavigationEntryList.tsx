import * as React from 'react';
import { ActivityIndicator, Animated, FlatList, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { RelativeTimeText } from '@/components/ui/selectionList/accessories/RelativeTimeText';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Typography } from '@/constants/Typography';
import {
    useSessionListRuntimeNowMs,
    useSessionListRuntimeWake,
} from '@/hooks/session/sessionListRuntimeClock';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import {
    buildTranscriptNavigationTimelineRows,
    type TranscriptNavigationTimelineRow,
} from './buildTranscriptNavigationTimelineRows';
import {
    resolveTranscriptNavigationEntryAccessibilityLabel,
    resolveTranscriptNavigationEntryPrimaryText,
    resolveTranscriptNavigationEntrySecondaryText,
} from './transcriptNavigationAccessibility';
import type {
    TranscriptNavigationEntry,
    TranscriptNavigationEntryJumpOutcome,
    TranscriptNavigationEntryPressHandler,
    TranscriptNavigationEntryPressResult,
} from './transcriptNavigationTypes';

type KeyboardEventLike = Readonly<{
    key?: string;
    nativeEvent?: Readonly<{ key?: string }>;
    preventDefault?: () => void;
    stopPropagation?: () => void;
}>;

type KeyboardViewProps = React.ComponentProps<typeof View> & Readonly<{
    onKeyDown?: (event: KeyboardEventLike) => void;
    tabIndex?: number;
}>;

const KeyboardView = View as React.ComponentType<KeyboardViewProps>;

/** Only the rows visible at first paint are worth staggering; later rows arrive on scroll. */
const TIMELINE_STAGGER_ROW_LIMIT = 6;
/** Local rhythm between sibling row entrances — a cadence, not a duration token. */
const TIMELINE_STAGGER_STEP_MS = 28;
/** Relative timestamps read at minute granularity, so a minute is the useful wake horizon. */
const RELATIVE_TIME_REFRESH_INTERVAL_MS = 60_000;

export type TranscriptNavigationEntryListProps = Readonly<{
    entries: readonly TranscriptNavigationEntry[];
    activeEntryId: string | null;
    onEntryPress: TranscriptNavigationEntryPressHandler;
    onRequestClose?: () => void;
    testIDPrefix: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    content: {
        paddingVertical: 4,
        paddingEnd: 10,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'stretch',
        minHeight: 56,
        minWidth: 0,
    },
    // The spine lives inside every row (entry rows and day headers alike) so it stays
    // continuous, and `flexDirection: 'row'` puts it on the leading edge in both LTR and
    // RTL without any physical `left` placement.
    rail: {
        width: 34,
        alignItems: 'center',
        alignSelf: 'stretch',
    },
    railSegment: {
        width: 2,
        flex: 1,
        backgroundColor: theme.colors.border.default,
    },
    railSegmentTravelled: {
        backgroundColor: theme.colors.state.info.foreground,
        opacity: 0.55,
    },
    railSegmentHidden: {
        backgroundColor: 'transparent',
    },
    node: {
        width: 11,
        height: 11,
        borderRadius: 6,
        marginVertical: 3,
        borderWidth: 1.5,
        borderColor: theme.colors.border.strong,
        backgroundColor: theme.colors.surface.base,
    },
    nodePinned: {
        borderColor: theme.colors.state.info.foreground,
        backgroundColor: theme.colors.state.info.foreground,
    },
    nodeCurrent: {
        width: 15,
        height: 15,
        borderRadius: 8,
        borderWidth: 3,
        borderColor: theme.colors.state.info.foreground,
        backgroundColor: theme.colors.surface.base,
    },
    staggerFrame: {
        flex: 1,
        minWidth: 0,
    },
    body: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        borderRadius: 10,
        paddingVertical: 9,
        paddingHorizontal: 10,
        marginVertical: 2,
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: 'transparent',
    },
    bodyFocused: {
        backgroundColor: theme.colors.surface.inset,
    },
    bodyActive: {
        backgroundColor: theme.colors.surface.selected,
        borderColor: theme.colors.border.default,
    },
    copy: {
        flex: 1,
        minWidth: 0,
        gap: 3,
    },
    primaryText: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    secondaryText: {
        color: theme.colors.text.secondary,
    },
    pendingText: {
        color: theme.colors.text.tertiary,
        ...Typography.default('italic'),
    },
    unloadedText: {
        color: theme.colors.text.secondary,
    },
    meta: {
        alignItems: 'flex-end',
        gap: 4,
        paddingTop: 1,
    },
    dayRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
        minWidth: 0,
    },
    dayLabelBlock: {
        flex: 1,
        minWidth: 0,
        paddingTop: 12,
        paddingBottom: 4,
        paddingHorizontal: 10,
    },
    dayLabel: {
        color: theme.colors.text.tertiary,
        ...Typography.default('semiBold'),
    },
    errorRow: {
        marginTop: 4,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
    },
    errorText: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.state.danger.foreground,
    },
    retryText: {
        color: theme.colors.state.info.foreground,
        ...Typography.default('semiBold'),
    },
}));

function normalizeKey(event: KeyboardEventLike): string | null {
    const key = event.key ?? event.nativeEvent?.key;
    return typeof key === 'string' ? key : null;
}

type EntryPressState = 'pending' | 'error';

function isThenable(value: unknown): value is Promise<TranscriptNavigationEntryJumpOutcome | void> {
    return typeof (value as { then?: unknown } | null | undefined)?.then === 'function';
}

function classifySettledOutcome(outcome: TranscriptNavigationEntryJumpOutcome | void): EntryPressState | null {
    if (outcome && outcome.status === 'not-found') return 'error';
    return null;
}

function resolveDayStartMs(atMs: number): number {
    const date = new Date(atMs);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

function formatTimelineDayLabel(dayStartMs: number, nowMs: number): string {
    const todayStartMs = resolveDayStartMs(nowMs);
    if (dayStartMs === todayStartMs) return t('sessionHistory.today');
    if (dayStartMs === todayStartMs - 86_400_000) return t('sessionHistory.yesterday');
    return new Date(dayStartMs).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: todayStartMs - dayStartMs > 300 * 86_400_000 ? 'numeric' : undefined,
    });
}

type TimelineNodeKind = 'none' | 'plain' | 'pinned' | 'current';

type TimelineRailProps = Readonly<{
    hasSegmentAbove: boolean;
    hasSegmentBelow: boolean;
    node: TimelineNodeKind;
    nodeTestID?: string;
    travelledAbove: boolean;
    travelledBelow: boolean;
}>;

const TimelineRail = React.memo((props: TimelineRailProps) => {
    const styles = stylesheet;
    return (
        <View
            style={styles.rail}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            pointerEvents="none"
        >
            <View
                style={[
                    styles.railSegment,
                    props.hasSegmentAbove ? null : styles.railSegmentHidden,
                    props.hasSegmentAbove && props.travelledAbove ? styles.railSegmentTravelled : null,
                ]}
            />
            {props.node === 'none' ? null : (
                <View
                    testID={props.nodeTestID}
                    style={[
                        styles.node,
                        props.node === 'pinned' ? styles.nodePinned : null,
                        props.node === 'current' ? styles.nodeCurrent : null,
                    ]}
                />
            )}
            <View
                style={[
                    styles.railSegment,
                    props.hasSegmentBelow ? null : styles.railSegmentHidden,
                    props.hasSegmentBelow && props.travelledBelow ? styles.railSegmentTravelled : null,
                ]}
            />
        </View>
    );
});

const TimelineStaggerFrame = React.memo((props: Readonly<{
    enabled: boolean;
    delayMs: number;
    children: React.ReactNode;
}>) => {
    const enabled = props.enabled;
    const progress = React.useRef(new Animated.Value(enabled ? 0 : 1)).current;

    React.useEffect(() => {
        if (!enabled) {
            progress.setValue(1);
            return;
        }
        const animation = Animated.timing(progress, {
            toValue: 1,
            delay: props.delayMs,
            duration: motionTokens.durationMs.fast,
            easing: motionTokens.easing.standard,
            useNativeDriver: true,
        });
        animation.start();
        return () => {
            animation.stop();
        };
    }, [enabled, progress, props.delayMs]);

    // The frame is present in both cases so reduced motion changes the animation, never
    // the layout: the row body still owns the remaining width beside the rail.
    return (
        <Animated.View
            style={[
                stylesheet.staggerFrame,
                enabled
                    ? {
                        opacity: progress,
                        transform: [{
                            translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }),
                        }],
                    }
                    : null,
            ]}
        >
            {props.children}
        </Animated.View>
    );
});

type TimelineEntryRowProps = Readonly<{
    entry: TranscriptNavigationEntry;
    entryIndex: number;
    isActive: boolean;
    isFocused: boolean;
    isFirstRow: boolean;
    isLastRow: boolean;
    isNewestEntry: boolean;
    nowMs: number;
    onFocusIndex: (entryIndex: number) => void;
    onPress: (entry: TranscriptNavigationEntry) => void;
    pressState: EntryPressState | null;
    reducedMotion: boolean;
    staggerIndex: number;
    testIDPrefix: string;
    travelledAbove: boolean;
    travelledBelow: boolean;
}>;

const TimelineEntryRow = React.memo((props: TimelineEntryRowProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const entry = props.entry;
    const primaryText = resolveTranscriptNavigationEntryPrimaryText(entry);
    const secondaryText = resolveTranscriptNavigationEntrySecondaryText(entry);
    // A turn with no reply preview is either still waiting for the agent (only ever the
    // newest turn) or anchored outside the loaded window. Saying "waiting" for an older
    // turn would be a lie about the session's state.
    const pendingReplyText = secondaryText
        ? null
        : entry.loaded === false
            ? t('session.transcriptNavigation.replyNotLoaded')
            : props.isNewestEntry
                ? t('session.transcriptNavigation.awaitingReply')
                : null;
    const node: TimelineNodeKind = props.isActive ? 'current' : entry.pinned ? 'pinned' : 'plain';

    return (
        <View style={styles.row}>
            <TimelineRail
                hasSegmentAbove={!props.isFirstRow}
                hasSegmentBelow={!props.isLastRow}
                node={node}
                nodeTestID={`${props.testIDPrefix}-node-${node}:${entry.id}`}
                travelledAbove={props.travelledAbove}
                travelledBelow={props.travelledBelow}
            />
            <TimelineStaggerFrame
                enabled={!props.reducedMotion && props.staggerIndex >= 0}
                delayMs={Math.max(0, props.staggerIndex) * TIMELINE_STAGGER_STEP_MS}
            >
                <Pressable
                    testID={`${props.testIDPrefix}-entry:${entry.id}`}
                    onPress={() => props.onPress(entry)}
                    onFocus={() => props.onFocusIndex(props.entryIndex)}
                    style={[
                        styles.body,
                        props.isFocused && !props.isActive ? styles.bodyFocused : null,
                        props.isActive ? styles.bodyActive : null,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={resolveTranscriptNavigationEntryAccessibilityLabel(entry)}
                    accessibilityState={{ selected: props.isActive }}
                >
                    <View style={styles.copy}>
                        <Text
                            numberOfLines={2}
                            style={[styles.primaryText, entry.loaded ? null : styles.unloadedText]}
                        >
                            {primaryText}
                        </Text>
                        {secondaryText ? (
                            <Text numberOfLines={2} style={styles.secondaryText}>
                                {secondaryText}
                            </Text>
                        ) : null}
                        {pendingReplyText ? (
                            <Text
                                testID={`${props.testIDPrefix}-entry-pending-reply:${entry.id}`}
                                numberOfLines={1}
                                style={styles.pendingText}
                            >
                                {pendingReplyText}
                            </Text>
                        ) : null}
                        {props.pressState === 'error' ? (
                            <View testID={`${props.testIDPrefix}-entry-error:${entry.id}`} style={styles.errorRow}>
                                <Text numberOfLines={1} style={styles.errorText}>
                                    {t('session.transcriptNavigation.jumpFailed')}
                                </Text>
                                <Pressable
                                    testID={`${props.testIDPrefix}-entry-retry:${entry.id}`}
                                    onPress={() => props.onPress(entry)}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('common.retry')}
                                    hitSlop={6}
                                >
                                    <Text numberOfLines={1} style={styles.retryText}>
                                        {t('common.retry')}
                                    </Text>
                                </Pressable>
                            </View>
                        ) : null}
                    </View>
                    <View style={styles.meta}>
                        {entry.createdAtMs !== null ? (
                            <RelativeTimeText atMs={entry.createdAtMs} nowMs={props.nowMs} />
                        ) : null}
                        {props.pressState === 'pending' ? (
                            <ActivityIndicator
                                testID={`${props.testIDPrefix}-entry-pending:${entry.id}`}
                                size="small"
                                color={theme.colors.text.secondary}
                            />
                        ) : entry.pinned ? (
                            <Icon name="push-pin" size={14} color={theme.colors.state.info.foreground} />
                        ) : null}
                    </View>
                </Pressable>
            </TimelineStaggerFrame>
        </View>
    );
});

export const TranscriptNavigationEntryList = React.memo((props: TranscriptNavigationEntryListProps) => {
    const styles = stylesheet;
    const [focusedIndex, setFocusedIndex] = React.useState(0);
    const [pressStates, setPressStates] = React.useState<ReadonlyMap<string, EntryPressState>>(() => new Map());
    const pressTokensRef = React.useRef(new Map<string, number>());
    const mountedRef = React.useRef(true);
    const reducedMotion = useReducedMotionPreference();
    const entries = props.entries;
    const activeEntryId = props.activeEntryId;
    const onEntryPress = props.onEntryPress;
    const onRequestClose = props.onRequestClose;
    const testIDPrefix = props.testIDPrefix;

    // Relative timestamps ride the app's shared runtime clock rather than a private timer,
    // so every surface reading "5m ago" crosses the same minute boundary in one commit.
    const hasTimestampedEntry = React.useMemo(
        () => entries.some((entry) => entry.createdAtMs !== null),
        [entries],
    );
    const nowMs = useSessionListRuntimeNowMs(hasTimestampedEntry);
    useSessionListRuntimeWake(
        hasTimestampedEntry ? nowMs + RELATIVE_TIME_REFRESH_INTERVAL_MS : null,
        hasTimestampedEntry,
    );

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    React.useEffect(() => {
        setFocusedIndex((current) => {
            if (entries.length === 0) return 0;
            return Math.min(current, entries.length - 1);
        });
    }, [entries]);

    const setEntryPressState = React.useCallback((entryId: string, state: EntryPressState | null) => {
        if (!mountedRef.current) return;
        setPressStates((current) => {
            if ((current.get(entryId) ?? null) === state) return current;
            const next = new Map(current);
            if (state === null) {
                next.delete(entryId);
            } else {
                next.set(entryId, state);
            }
            return next;
        });
    }, []);

    const handleEntryPress = React.useCallback((entry: TranscriptNavigationEntry) => {
        const token = (pressTokensRef.current.get(entry.id) ?? 0) + 1;
        pressTokensRef.current.set(entry.id, token);
        const isStale = () => pressTokensRef.current.get(entry.id) !== token;

        let result: TranscriptNavigationEntryPressResult;
        try {
            result = onEntryPress(entry);
        } catch {
            setEntryPressState(entry.id, 'error');
            return;
        }

        if (!isThenable(result)) {
            setEntryPressState(entry.id, classifySettledOutcome(result));
            return;
        }

        // Only surface a pending indicator when data is actually pending (unloaded target):
        // a jump into an already-loaded row settles within a frame and a spinner would flash.
        setEntryPressState(entry.id, entry.loaded === false ? 'pending' : null);
        result.then(
            (outcome) => {
                if (isStale()) return;
                setEntryPressState(entry.id, classifySettledOutcome(outcome));
            },
            () => {
                if (isStale()) return;
                setEntryPressState(entry.id, 'error');
            },
        );
    }, [onEntryPress, setEntryPressState]);

    const activateFocusedEntry = React.useCallback(() => {
        const entry = entries[focusedIndex];
        if (entry) handleEntryPress(entry);
    }, [entries, focusedIndex, handleEntryPress]);

    const handleKeyDown = React.useCallback((event: KeyboardEventLike) => {
        const key = normalizeKey(event);
        if (!key) return;

        if (key === 'Escape') {
            if (!onRequestClose) return;
            event.preventDefault?.();
            event.stopPropagation?.();
            onRequestClose();
            return;
        }

        if (entries.length === 0) return;

        if (key === 'ArrowDown') {
            event.preventDefault?.();
            setFocusedIndex((current) => Math.min(entries.length - 1, current + 1));
            return;
        }
        if (key === 'ArrowUp') {
            event.preventDefault?.();
            setFocusedIndex((current) => Math.max(0, current - 1));
            return;
        }
        if (key === 'Home') {
            event.preventDefault?.();
            setFocusedIndex(0);
            return;
        }
        if (key === 'End') {
            event.preventDefault?.();
            setFocusedIndex(entries.length - 1);
            return;
        }
        if (key === 'Enter' || key === ' ') {
            event.preventDefault?.();
            activateFocusedEntry();
        }
    }, [activateFocusedEntry, entries.length, onRequestClose]);

    const rows = React.useMemo(() => buildTranscriptNavigationTimelineRows(entries), [entries]);
    const activeEntryIndex = React.useMemo(
        () => entries.findIndex((entry) => entry.id === activeEntryId),
        [activeEntryId, entries],
    );

    const renderRow = React.useCallback(({ item, index }: Readonly<{ item: TranscriptNavigationTimelineRow; index: number }>) => {
        const isFirstRow = index === 0;
        const isLastRow = index === rows.length - 1;
        if (item.kind === 'day') {
            return (
                <View testID={`${testIDPrefix}-day:${item.dayStartMs}`} style={styles.dayRow}>
                    <TimelineRail
                        hasSegmentAbove={!isFirstRow}
                        hasSegmentBelow={!isLastRow}
                        node="none"
                        travelledAbove={false}
                        travelledBelow={false}
                    />
                    <View style={styles.dayLabelBlock}>
                        <Text numberOfLines={1} style={styles.dayLabel}>
                            {formatTimelineDayLabel(item.dayStartMs, nowMs)}
                        </Text>
                    </View>
                </View>
            );
        }
        // The spine above the reader's current position is tinted, so the panel doubles
        // as a "how far through this session am I" indicator.
        const travelled = activeEntryIndex >= 0 && item.entryIndex <= activeEntryIndex;
        return (
            <TimelineEntryRow
                entry={item.entry}
                entryIndex={item.entryIndex}
                isActive={item.entry.id === activeEntryId}
                isFocused={item.entryIndex === focusedIndex}
                isFirstRow={isFirstRow}
                isLastRow={isLastRow}
                isNewestEntry={item.entryIndex === entries.length - 1}
                nowMs={nowMs}
                onFocusIndex={setFocusedIndex}
                onPress={handleEntryPress}
                pressState={pressStates.get(item.entry.id) ?? null}
                reducedMotion={reducedMotion}
                staggerIndex={index < TIMELINE_STAGGER_ROW_LIMIT ? index : -1}
                testIDPrefix={testIDPrefix}
                travelledAbove={travelled}
                travelledBelow={activeEntryIndex >= 0 && item.entryIndex < activeEntryIndex}
            />
        );
    }, [
        activeEntryId,
        activeEntryIndex,
        entries.length,
        focusedIndex,
        handleEntryPress,
        nowMs,
        pressStates,
        reducedMotion,
        rows.length,
        styles,
        testIDPrefix,
    ]);

    return (
        <KeyboardView
            testID={`${testIDPrefix}-entry-list`}
            style={styles.root}
            onKeyDown={handleKeyDown}
            tabIndex={0}
            accessibilityRole="list"
        >
            <FlatList
                data={rows}
                extraData={renderRow}
                keyExtractor={keyExtractor}
                renderItem={renderRow}
                style={styles.root}
                contentContainerStyle={styles.content}
                keyboardShouldPersistTaps="handled"
                initialNumToRender={16}
                windowSize={7}
                removeClippedSubviews={false}
            />
        </KeyboardView>
    );
});

function keyExtractor(row: TranscriptNavigationTimelineRow): string {
    return row.id;
}
