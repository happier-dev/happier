import * as React from 'react';
import { Animated, FlatList, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
    useSessionListRuntimeNowMs,
    useSessionListRuntimeWake,
} from '@/hooks/session/sessionListRuntimeClock';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import {
    buildTranscriptNavigationTimelineRows,
    type TranscriptNavigationTimelineRow,
} from './buildTranscriptNavigationTimelineRows';
import {
    resolveTranscriptNavigationEntryAccessibilityLabel,
    resolveTranscriptNavigationEntryPrimaryText,
    resolveTranscriptNavigationEntrySecondaryText,
} from './transcriptNavigationAccessibility';
import { isTranscriptNavigationEntryWaiting } from './transcriptNavigationFilters';
import {
    formatTranscriptNavigationClockTime,
    formatTranscriptNavigationDay,
} from './transcriptNavigationTimeFormat';
import { TranscriptNavigationTurnFactsStrip } from './TranscriptNavigationTurnFactsStrip';
import type {
    TranscriptNavigationEntry,
    TranscriptNavigationEntryJumpOutcome,
    TranscriptNavigationEntryPressHandler,
    TranscriptNavigationEntryPressResult,
    TranscriptNavigationTurnApproval,
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
/** Day names ("Today") change at midnight; a minute is the useful wake horizon. */
const DAY_LABEL_REFRESH_INTERVAL_MS = 60_000;
const EMPTY_IDS: readonly string[] = Object.freeze([]);

export type TranscriptNavigationNewestTurnState = 'working' | 'waiting' | null;

export type TranscriptNavigationSessionStart = Readonly<{
    atMs: number | null;
    /** "Claude on MacBook Pro"; null when neither is known. */
    detail: string | null;
}>;

export type TranscriptNavigationEntryListProps = Readonly<{
    entries: readonly TranscriptNavigationEntry[];
    activeEntryId: string | null;
    /** The turns on screen in the transcript right now (the "you are here" band). */
    visibleEntryIds?: readonly string[];
    /** What the session is doing with its newest turn, from the canonical awareness owner. */
    newestTurn?: TranscriptNavigationNewestTurnState;
    /** Show each turn's approval outcomes inline (the Approvals filter). */
    showApprovals?: boolean;
    /** Closes the list with the session's start; pass only when the whole history is listed. */
    sessionStart?: TranscriptNavigationSessionStart | null;
    /** One quiet line after the last row: what a filter shows, partial history, loading earlier. */
    footer?: React.ReactNode;
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
        paddingTop: 2,
        paddingBottom: 16,
        paddingStart: 10,
        paddingEnd: 12,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'stretch',
        minWidth: 0,
    },
    // The spine lives inside every row (entry rows and day headers alike) so it stays
    // continuous, and `flexDirection: 'row'` puts it on the leading edge in both LTR and
    // RTL without any physical `left` placement.
    rail: {
        width: 24,
        alignItems: 'center',
        alignSelf: 'stretch',
    },
    railSegment: {
        width: 1.5,
        backgroundColor: theme.colors.border.default,
    },
    railSegmentLead: {
        height: 14,
    },
    railSegmentTail: {
        flex: 1,
    },
    railSegmentInView: {
        width: 2,
        backgroundColor: theme.colors.text.secondary,
    },
    railSegmentHidden: {
        backgroundColor: 'transparent',
    },
    node: {
        width: 9,
        height: 9,
        borderRadius: 5,
        borderWidth: 1.5,
        borderColor: theme.colors.border.strong,
        backgroundColor: theme.colors.surface.base,
    },
    nodeCurrent: {
        width: 11,
        height: 11,
        borderRadius: 6,
        borderWidth: 0,
        backgroundColor: theme.colors.text.primary,
    },
    nodeWaiting: {
        width: 10,
        height: 10,
        borderColor: theme.colors.state.warning.foreground,
    },
    nodeFailed: {
        borderWidth: 2,
        borderColor: theme.colors.state.danger.foreground,
    },
    nodeGlyph: {
        width: 16,
        height: 16,
        alignItems: 'center',
        justifyContent: 'center',
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
        gap: 8,
        borderRadius: 10,
        paddingTop: 6,
        paddingBottom: 8,
        paddingHorizontal: 8,
        marginStart: 4,
    },
    bodyInView: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    bodyJoinAbove: {
        borderTopLeftRadius: 0,
        borderTopRightRadius: 0,
    },
    bodyJoinBelow: {
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
    },
    bodyFocused: {
        backgroundColor: theme.colors.surface.inset,
    },
    bodyActive: {
        backgroundColor: theme.colors.surface.selected,
    },
    copy: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    primaryText: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
        fontSize: 13,
        lineHeight: 18,
    },
    pinnedLabel: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    pinnedLabelText: {
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
        fontSize: 12,
        lineHeight: 17,
    },
    secondaryText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        lineHeight: 17,
    },
    failedText: {
        color: theme.colors.state.danger.foreground,
    },
    waitingLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        minWidth: 0,
    },
    waitingText: {
        flexShrink: 1,
        color: theme.colors.state.warning.foreground,
        ...Typography.default('semiBold'),
        fontSize: 12,
        lineHeight: 17,
    },
    pendingText: {
        color: theme.colors.text.tertiary,
        ...Typography.default('italic'),
    },
    unloadedText: {
        color: theme.colors.text.secondary,
    },
    approvalLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        marginTop: 2,
        minWidth: 0,
    },
    approvalText: {
        flexShrink: 1,
        color: theme.colors.text.primary,
    },
    time: {
        minWidth: 34,
        flexShrink: 0,
        fontSize: 11,
        lineHeight: 16,
        textAlign: 'right',
        paddingTop: 1,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
    timeLive: {
        color: theme.colors.state.warning.foreground,
        ...Typography.default('semiBold'),
    },
    dayRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
        minWidth: 0,
    },
    dayLabelBlock: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: 6,
        paddingTop: 12,
        paddingBottom: 6,
        paddingHorizontal: 12,
    },
    dayName: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    dayDate: {
        color: theme.colors.text.tertiary,
    },
    startCopy: {
        flex: 1,
        minWidth: 0,
        paddingTop: 10,
        paddingBottom: 6,
        paddingHorizontal: 12,
        gap: 2,
    },
    startText: {
        color: theme.colors.text.tertiary,
    },
    footer: {
        paddingTop: 8,
        paddingStart: 28,
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

export type TranscriptNavigationNodeKind = 'none' | 'plain' | 'pinned' | 'current' | 'live' | 'waiting' | 'failed' | 'start';

/**
 * The marker on the spine says what the turn is: live now, waiting for you, the one you are
 * reading, ended in failure, pinned, or simply answered. Live and waiting outrank the reading
 * position because they are the present; the reading position outranks history.
 */
export function resolveTranscriptNavigationNodeKind(params: Readonly<{
    entry: TranscriptNavigationEntry;
    isCurrent: boolean;
    newestTurn: TranscriptNavigationNewestTurnState;
}>): TranscriptNavigationNodeKind {
    if (params.newestTurn === 'working') return 'live';
    if (params.newestTurn === 'waiting' || isTranscriptNavigationEntryWaiting(params.entry)) return 'waiting';
    if (params.isCurrent) return 'current';
    if (params.entry.facts?.lastToolFailed === true) return 'failed';
    if (params.entry.pinned) return 'pinned';
    return 'plain';
}

type TimelineRailProps = Readonly<{
    hasSegmentAbove: boolean;
    hasSegmentBelow: boolean;
    inView?: boolean;
    inViewAbove?: boolean;
    node: TranscriptNavigationNodeKind;
    nodeTestID?: string;
}>;

const TimelineNode = React.memo((props: Readonly<{ kind: TranscriptNavigationNodeKind; testID?: string }>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    switch (props.kind) {
        case 'none':
            return null;
        case 'live':
            return (
                <View testID={props.testID} style={styles.nodeGlyph}>
                    <ActivitySpinner size={13} color={theme.colors.state.warning.foreground} />
                </View>
            );
        case 'pinned':
            return (
                <View testID={props.testID} style={styles.nodeGlyph}>
                    <Icon name="push-pin" size={13} color={theme.colors.text.secondary} />
                </View>
            );
        default:
            return (
                <View
                    testID={props.testID}
                    style={[
                        styles.node,
                        props.kind === 'current' ? styles.nodeCurrent : null,
                        props.kind === 'waiting' ? styles.nodeWaiting : null,
                        props.kind === 'failed' ? styles.nodeFailed : null,
                    ]}
                />
            );
    }
});

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
                    styles.railSegmentLead,
                    props.hasSegmentAbove ? null : styles.railSegmentHidden,
                    props.hasSegmentAbove && props.inView && props.inViewAbove ? styles.railSegmentInView : null,
                ]}
            />
            <TimelineNode kind={props.node} testID={props.nodeTestID} />
            <View
                style={[
                    styles.railSegment,
                    styles.railSegmentTail,
                    props.hasSegmentBelow ? null : styles.railSegmentHidden,
                    props.hasSegmentBelow && props.inView ? styles.railSegmentInView : null,
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

const ApprovalOutcomes = React.memo((props: Readonly<{ approvals: readonly TranscriptNavigationTurnApproval[] }>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <>
            {props.approvals.filter((approval) => approval.outcome !== 'pending').map((approval, index) => {
                const label = approval.label ?? '';
                return (
                    <View key={index} style={styles.approvalLine}>
                        <Icon
                            name="shield-check"
                            size={12}
                            color={approval.outcome === 'allowed' ? theme.colors.state.success.foreground : theme.colors.text.tertiary}
                        />
                        <Text numberOfLines={1} style={styles.approvalText}>
                            {approval.outcome === 'allowed'
                                ? t('session.transcriptNavigation.approvalAllowed', { label })
                                : t('session.transcriptNavigation.approvalDenied', { label })}
                        </Text>
                    </View>
                );
            })}
        </>
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
    inView: boolean;
    inViewAbove: boolean;
    inViewBelow: boolean;
    newestTurn: TranscriptNavigationNewestTurnState;
    onFocusIndex: (entryIndex: number) => void;
    onPress: (entry: TranscriptNavigationEntry) => void;
    pressState: EntryPressState | null;
    reducedMotion: boolean;
    showApprovals: boolean;
    staggerIndex: number;
    testIDPrefix: string;
}>;

function isPinnedAnswer(entry: TranscriptNavigationEntry): boolean {
    return entry.kind === 'pinned-assistant' || entry.kind === 'pinned-tool' || entry.kind === 'deep-link-target';
}

const TimelineEntryRow = React.memo((props: TimelineEntryRowProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const entry = props.entry;
    const facts = entry.facts ?? null;
    const node = resolveTranscriptNavigationNodeKind({
        entry,
        isCurrent: props.isActive,
        newestTurn: props.isNewestEntry ? props.newestTurn : null,
    });
    const live = node === 'live';
    const pendingApproval = facts?.approvals.find((approval) => approval.outcome === 'pending') ?? null;
    const waiting = node === 'waiting' || pendingApproval !== null;
    const present = live || (props.isNewestEntry && waiting && facts?.endedAtMs === null);
    const answer = isPinnedAnswer(entry);
    const primaryText = resolveTranscriptNavigationEntryPrimaryText(entry);
    const secondaryText = answer ? null : resolveTranscriptNavigationEntrySecondaryText(entry);
    // A turn with no reply preview is either still waiting for the agent (only ever the
    // newest turn) or anchored outside the loaded window. Saying "waiting" for an older
    // turn would be a lie about the session's state.
    const pendingReplyText = secondaryText || waiting || answer
        ? null
        : entry.loaded === false
            ? t('session.transcriptNavigation.replyNotLoaded')
            : props.isNewestEntry
                ? t('session.transcriptNavigation.awaitingReply')
                : null;

    return (
        <View style={styles.row}>
            <TimelineRail
                hasSegmentAbove={!props.isFirstRow}
                hasSegmentBelow={!props.isLastRow}
                inView={props.inView}
                inViewAbove={props.inViewAbove}
                node={node}
                nodeTestID={`${props.testIDPrefix}-node-${node}:${entry.id}`}
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
                        props.inView ? styles.bodyInView : null,
                        props.inView && props.inViewAbove ? styles.bodyJoinAbove : null,
                        props.inView && props.inViewBelow ? styles.bodyJoinBelow : null,
                        props.isFocused && !props.isActive ? styles.bodyFocused : null,
                        props.isActive ? styles.bodyActive : null,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={resolveTranscriptNavigationEntryAccessibilityLabel(entry)}
                    accessibilityState={{ selected: props.isActive }}
                >
                    {props.inView ? <View testID={`${props.testIDPrefix}-inview:${entry.id}`} /> : null}
                    <View style={styles.copy}>
                        {answer ? (
                            <View style={styles.pinnedLabel}>
                                <Icon name="push-pin" size={12} color={theme.colors.text.secondary} />
                                <Text numberOfLines={1} style={styles.pinnedLabelText}>
                                    {t('session.transcriptNavigation.pinnedAnswer')}
                                </Text>
                            </View>
                        ) : null}
                        <Text
                            numberOfLines={2}
                            style={answer
                                ? styles.secondaryText
                                : [styles.primaryText, entry.loaded ? null : styles.unloadedText]}
                        >
                            {primaryText}
                        </Text>
                        {waiting ? (
                            <View testID={`${props.testIDPrefix}-entry-waiting:${entry.id}`} style={styles.waitingLine}>
                                <Icon name="warning" size={13} color={theme.colors.state.warning.foreground} />
                                <Text numberOfLines={1} style={styles.waitingText}>
                                    {pendingApproval?.label
                                        ? t('session.transcriptNavigation.waitingForYouOn', { label: pendingApproval.label })
                                        : t('session.transcriptNavigation.waitingForYou')}
                                </Text>
                            </View>
                        ) : secondaryText ? (
                            <Text numberOfLines={2} style={[styles.secondaryText, node === 'failed' ? styles.failedText : null]}>
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
                        {props.showApprovals && facts ? <ApprovalOutcomes approvals={facts.approvals} /> : null}
                        {facts && !answer ? (
                            <TranscriptNavigationTurnFactsStrip
                                facts={facts}
                                createdAtMs={entry.createdAtMs}
                                live={present}
                                showApprovalCounts={!props.showApprovals}
                                testID={`${props.testIDPrefix}-entry-facts:${entry.id}`}
                            />
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
                    {props.pressState === 'pending' ? (
                        <ActivitySpinner
                            testID={`${props.testIDPrefix}-entry-pending:${entry.id}`}
                            size="small"
                            color={theme.colors.text.secondary}
                        />
                    ) : (
                        <Text numberOfLines={1} style={[styles.time, live || waiting ? styles.timeLive : null]}>
                            {present
                                ? t('session.transcriptNavigation.now')
                                : entry.createdAtMs !== null
                                    ? formatTranscriptNavigationClockTime(entry.createdAtMs)
                                    : ''}
                        </Text>
                    )}
                </Pressable>
            </TimelineStaggerFrame>
        </View>
    );
});

const DayHeaderRow = React.memo((props: Readonly<{
    dayStartMs: number;
    isFirstRow: boolean;
    isLastRow: boolean;
    nowMs: number;
    testIDPrefix: string;
}>) => {
    const styles = stylesheet;
    const day = formatTranscriptNavigationDay(props.dayStartMs, props.nowMs);
    return (
        <View
            testID={`${props.testIDPrefix}-day:${props.dayStartMs}`}
            style={styles.dayRow}
            accessibilityRole="header"
        >
            <TimelineRail hasSegmentAbove={!props.isFirstRow} hasSegmentBelow={!props.isLastRow} node="none" />
            <View style={styles.dayLabelBlock}>
                <Text numberOfLines={1} style={styles.dayName}>{day.name ?? day.date}</Text>
                {day.name ? <Text numberOfLines={1} style={styles.dayDate}>{day.date}</Text> : null}
            </View>
        </View>
    );
});

const SessionStartRow = React.memo((props: Readonly<{
    start: TranscriptNavigationSessionStart;
    nowMs: number;
    testIDPrefix: string;
}>) => {
    const styles = stylesheet;
    const atMs = props.start.atMs;
    const when = atMs !== null
        ? (() => {
            const day = formatTranscriptNavigationDay(new Date(atMs).setHours(0, 0, 0, 0), props.nowMs);
            return `${day.name ?? day.date} ${formatTranscriptNavigationClockTime(atMs)}`;
        })()
        : null;
    const detail = [when, props.start.detail].filter(Boolean).join(' · ');
    return (
        <View testID={`${props.testIDPrefix}-session-start`} style={styles.dayRow}>
            <TimelineRail hasSegmentAbove hasSegmentBelow={false} node="plain" />
            <View style={styles.startCopy}>
                <Text style={styles.startText}>{t('session.transcriptNavigation.sessionStarted')}</Text>
                {detail ? <Text style={styles.startText}>{detail}</Text> : null}
            </View>
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
    const visibleEntryIds = props.visibleEntryIds ?? EMPTY_IDS;
    const newestTurn = props.newestTurn ?? null;
    const showApprovals = props.showApprovals === true;
    const sessionStart = props.sessionStart ?? null;
    const onEntryPress = props.onEntryPress;
    const onRequestClose = props.onRequestClose;
    const testIDPrefix = props.testIDPrefix;

    // Day names ride the app's shared runtime clock rather than a private timer, so "Today"
    // turns into "Yesterday" in the same commit as every other surface.
    const hasTimestampedEntry = React.useMemo(
        () => entries.some((entry) => entry.createdAtMs !== null),
        [entries],
    );
    const nowMs = useSessionListRuntimeNowMs(hasTimestampedEntry);
    useSessionListRuntimeWake(
        hasTimestampedEntry ? nowMs + DAY_LABEL_REFRESH_INTERVAL_MS : null,
        hasTimestampedEntry,
    );

    const rows = React.useMemo(
        () => buildTranscriptNavigationTimelineRows(entries, { sessionStart: sessionStart !== null }),
        [entries, sessionStart],
    );
    const displayEntries = React.useMemo(
        () => rows.flatMap((row) => (row.kind === 'entry' ? [row.entry] : [])),
        [rows],
    );
    const newestEntryId = entries[entries.length - 1]?.id ?? null;
    const visibleSet = React.useMemo(() => new Set(visibleEntryIds), [visibleEntryIds]);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    React.useEffect(() => {
        setFocusedIndex((current) => {
            if (displayEntries.length === 0) return 0;
            return Math.min(current, displayEntries.length - 1);
        });
    }, [displayEntries]);

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
        const entry = displayEntries[focusedIndex];
        if (entry) handleEntryPress(entry);
    }, [displayEntries, focusedIndex, handleEntryPress]);

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

        if (displayEntries.length === 0) return;

        if (key === 'ArrowDown') {
            event.preventDefault?.();
            setFocusedIndex((current) => Math.min(displayEntries.length - 1, current + 1));
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
            setFocusedIndex(displayEntries.length - 1);
            return;
        }
        if (key === 'Enter' || key === ' ') {
            event.preventDefault?.();
            activateFocusedEntry();
        }
    }, [activateFocusedEntry, displayEntries.length, onRequestClose]);

    const renderRow = React.useCallback(({ item, index }: Readonly<{ item: TranscriptNavigationTimelineRow; index: number }>) => {
        const isFirstRow = index === 0;
        const isLastRow = index === rows.length - 1;
        if (item.kind === 'day') {
            return (
                <DayHeaderRow
                    dayStartMs={item.dayStartMs}
                    isFirstRow={isFirstRow}
                    isLastRow={isLastRow}
                    nowMs={nowMs}
                    testIDPrefix={testIDPrefix}
                />
            );
        }
        if (item.kind === 'start') {
            return sessionStart ? <SessionStartRow start={sessionStart} nowMs={nowMs} testIDPrefix={testIDPrefix} /> : null;
        }
        const above = rows[index - 1];
        const below = rows[index + 1];
        const inView = visibleSet.has(item.entry.id);
        return (
            <TimelineEntryRow
                entry={item.entry}
                entryIndex={item.entryIndex}
                isActive={item.entry.id === activeEntryId}
                isFocused={item.entryIndex === focusedIndex}
                isFirstRow={isFirstRow}
                isLastRow={isLastRow}
                isNewestEntry={item.entry.id === newestEntryId}
                inView={inView}
                inViewAbove={inView && above?.kind === 'entry' && visibleSet.has(above.entry.id)}
                inViewBelow={inView && below?.kind === 'entry' && visibleSet.has(below.entry.id)}
                newestTurn={newestTurn}
                onFocusIndex={setFocusedIndex}
                onPress={handleEntryPress}
                pressState={pressStates.get(item.entry.id) ?? null}
                reducedMotion={reducedMotion}
                showApprovals={showApprovals}
                staggerIndex={index < TIMELINE_STAGGER_ROW_LIMIT ? index : -1}
                testIDPrefix={testIDPrefix}
            />
        );
    }, [
        activeEntryId,
        focusedIndex,
        handleEntryPress,
        newestEntryId,
        newestTurn,
        nowMs,
        pressStates,
        reducedMotion,
        rows,
        sessionStart,
        showApprovals,
        testIDPrefix,
        visibleSet,
    ]);

    const footer = props.footer ? <View style={styles.footer}>{props.footer}</View> : null;

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
                ListFooterComponent={footer}
            />
        </KeyboardView>
    );
});

function keyExtractor(row: TranscriptNavigationTimelineRow): string {
    return row.id;
}
