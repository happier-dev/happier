import * as React from 'react';
import { Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { SessionNavigationPill, sessionNavigationPillStyles } from '@/components/navigation/SessionNavigationPill';
import { Icon } from '@/components/ui/icons/Icon';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { shadowLevelStyle } from '@/shadowElevation';
import { t } from '@/text';

import { resolveSessionSwitcherPanelMotion, resolveSessionSwitcherRowReveal } from './sessionSwitcherMotion';
import {
    SESSION_SWITCHER_ROW_HEIGHT,
    type SessionSwitcherHeading,
    type SessionSwitcherPanelLayout,
} from './sessionSwitcherPanelLayout';
import type { SessionSwitcherRow, SessionSwitcherRowTone } from './sessionSwitcherRows';
import type { SessionSwitcherMode } from './useSessionSwitcher';

/**
 * The switcher: one panel above the bar for every gesture (drag up, sideways, hold). Rows are the
 * things themselves — the agent's mark, the session's name, its live status, when — and the row
 * under the thumb rises out of the list while the last thing said in it shows above the panel.
 *
 * Everything that moves per frame is a worklet over the shared values the bar's gesture writes
 * (`useSessionSwitcherState`): React renders the rows once per open and the selection's peek once
 * per row crossed, never per frame. In `docked` mode the same panel takes taps.
 */

export const SESSION_SWITCHER_PANEL_TEST_ID = 'session-switcher-panel';
export const SESSION_SWITCHER_ROW_TEST_ID = 'session-switcher-row';

const PANEL_RADIUS = 28;
const PANEL_PADDING = 6;
/** The raised row overhangs the list by this much, so it reads as lifted out of it. */
const RAISE_OVERHANG = 6;
const DOCKED_HEADER_HEIGHT = 52;

const styles = StyleSheet.create((theme) => ({
    panel: {
        overflow: 'hidden',
    },
    viewport: {
        overflow: 'hidden',
    },
    list: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
    },
    raised: {
        position: 'absolute',
        left: PANEL_PADDING - RAISE_OVERHANG,
        right: PANEL_PADDING - RAISE_OVERHANG,
        height: SESSION_SWITCHER_ROW_HEIGHT,
        borderRadius: PANEL_RADIUS - PANEL_PADDING + RAISE_OVERHANG,
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        ...shadowLevelStyle(theme.colors.shadowLevels[2]),
    },
    row: {
        position: 'absolute',
        left: 0,
        right: 0,
        height: SESSION_SWITCHER_ROW_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 18,
        gap: 12,
    },
    mark: {
        width: 22,
        alignItems: 'center',
    },
    body: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        fontSize: 15,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    titleUnavailable: {
        color: theme.colors.text.tertiary,
    },
    statusLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 1,
    },
    status: {
        flexShrink: 1,
        fontSize: 13,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    time: {
        fontSize: 12,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
        ...Typography.default(),
    },
    here: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 999,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.inset,
        ...Typography.default('semiBold'),
    },
    heading: {
        position: 'absolute',
        left: 0,
        right: 0,
        height: 30,
        paddingHorizontal: 18,
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingBottom: 4,
        gap: 6,
    },
    headingText: {
        fontSize: 12.5,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
    headingMeta: {
        fontSize: 12.5,
        color: theme.colors.text.tertiary,
        ...Typography.default(),
    },
    end: {
        position: 'absolute',
        left: 0,
        right: 0,
        height: 60,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 18,
        gap: 12,
    },
    dockedHeader: {
        height: DOCKED_HEADER_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 18,
    },
    dockedTitle: {
        fontSize: 17,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    link: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        minHeight: 44,
    },
    linkText: {
        fontSize: 15,
        color: theme.colors.text.link,
        ...Typography.default(),
    },
    peek: {
        position: 'absolute',
        left: 18,
        right: 18,
        paddingHorizontal: 14,
        paddingVertical: 10,
        gap: 4,
    },
    peekWhere: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    peekWhereText: {
        flexShrink: 1,
        fontSize: 12.5,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    peekText: {
        fontSize: 15,
        lineHeight: 20,
        color: theme.colors.text.primary,
        ...Typography.default(),
    },
}));

function toneColor(tone: SessionSwitcherRowTone, colors: ReturnType<typeof useUnistyles>['theme']['colors']): string {
    if (tone === 'attention') return colors.state.warning.foreground;
    if (tone === 'failed') return colors.state.danger.foreground;
    return colors.text.secondary;
}

const RowMark = React.memo(function RowMark(props: Readonly<{ row: SessionSwitcherRow; size: number }>) {
    const { theme } = useUnistyles();
    const { row } = props;
    if (row.unavailable) return <Icon name="cloud-slash" size={props.size} color={theme.colors.text.tertiary} />;
    if (row.target.kind === 'session') {
        return (
            <SessionAgentCatalogIdentityIcon
                // Unknown identity degrades to the catalog owner's neutral mark; never a default Agent.
                agentId={row.agentId ?? ''}
                machineId={row.machineId}
                serverId={row.serverId}
                color={theme.colors.text.primary}
                size={props.size}
            />
        );
    }
    return <Icon name={row.icon ?? 'file'} size={props.size} color={theme.colors.text.secondary} />;
});

function StatusLine(props: Readonly<{ row: SessionSwitcherRow }>) {
    const { theme } = useUnistyles();
    const { row } = props;
    if (row.draft) {
        return (
            <View style={styles.statusLine}>
                <Icon name="pencil-simple" size={13} color={theme.colors.text.secondary} />
                <Text style={styles.status} numberOfLines={1}>{t('phoneNav.switcher.draft', { text: row.draft })}</Text>
            </View>
        );
    }
    if (!row.status) return null;
    const color = toneColor(row.status.tone, theme.colors);
    return (
        <View style={styles.statusLine}>
            {row.status.tone === 'working'
                ? <ActivitySpinner size={11} color={theme.colors.text.secondary} />
                : row.status.tone === 'attention' || row.status.tone === 'failed'
                    ? <StatusDot color={color} size={7} />
                    : null}
            <Text style={[styles.status, { color }]} numberOfLines={1}>{row.status.text}</Text>
        </View>
    );
}

const SwitcherRow = React.memo(function SwitcherRow(props: Readonly<{
    row: SessionSwitcherRow;
    bottom: number;
    index: number;
    here: boolean;
    ghost: SharedValue<number>;
    interactive: boolean;
    onPress?: (row: SessionSwitcherRow) => void;
}>) {
    const { ghost, index } = props;
    const revealStyle = useAnimatedStyle(() => ({ opacity: resolveSessionSwitcherRowReveal(ghost.value, index < 0 ? 0 : index) }), [ghost, index]);
    const content = (
        <>
            <View style={styles.mark}><RowMark row={props.row} size={19} /></View>
            <View style={styles.body}>
                <Text style={[styles.title, props.row.unavailable && styles.titleUnavailable]} numberOfLines={1}>{props.row.title}</Text>
                <StatusLine row={props.row} />
            </View>
            {props.here
                ? <Text style={styles.here}>{t('phoneNav.switcher.here')}</Text>
                : props.row.timeLabel ? <Text style={styles.time}>{props.row.timeLabel}</Text> : null}
        </>
    );
    return (
        <Animated.View style={[styles.row, { bottom: props.bottom }, revealStyle]} testID={SESSION_SWITCHER_ROW_TEST_ID}>
            {props.interactive ? (
                <Pressable
                    style={[styles.row, { position: 'relative', paddingHorizontal: 0 }]}
                    onPress={() => props.onPress?.(props.row)}
                    accessibilityRole="button"
                    accessibilityLabel={props.row.status ? `${props.row.title}, ${props.row.status.text}` : props.row.title}
                >
                    {content}
                </Pressable>
            ) : content}
        </Animated.View>
    );
});

function headingLabel(heading: SessionSwitcherHeading): string {
    switch (heading) {
        case 'openTabs': return t('phoneNav.switcher.openTabs');
        case 'recent': return t('phoneNav.switcher.recent');
        case 'recentOnThisDevice': return t('phoneNav.switcher.recentOnThisDevice');
        case 'sessions': return t('phoneNav.switcher.sessions');
        case 'nextInSessions': return t('phoneNav.switcher.nextInSessions');
        case 'previousInSessions': return t('phoneNav.switcher.previousInSessions');
        case 'furtherBack': return t('phoneNav.switcher.furtherBack');
        case 'moreRecent': return t('phoneNav.switcher.moreRecent');
    }
}

export type SessionSwitcherPanelProps = Readonly<{
    mode: SessionSwitcherMode;
    docked: boolean;
    layout: SessionSwitcherPanelLayout;
    /** The panel's list viewport, decided by the band from the room above the bar. */
    viewportHeight: number;
    /** The row under the thumb, for the peek (JS-side mirror of the selection). */
    selected: SessionSwitcherRow | null;
    ghost: SharedValue<number>;
    lift: SharedValue<number>;
    index: SharedValue<number>;
    scroll: SharedValue<number>;
    reducedMotion: boolean;
    onOpenRow: (row: SessionSwitcherRow) => void;
    onAllSessions: () => void;
}>;

export const SessionSwitcherPanel = React.memo(function SessionSwitcherPanel(props: SessionSwitcherPanelProps) {
    const { theme } = useUnistyles();
    const { ghost, lift, index, scroll, reducedMotion, layout } = props;
    const rowBottoms = layout.rowBottoms;
    const hereBottom = layout.hereBottom;
    const chromeHeight = props.docked ? DOCKED_HEADER_HEIGHT : 0;

    const panelStyle = useAnimatedStyle(() => {
        const motion = resolveSessionSwitcherPanelMotion({ ghost: ghost.value, lift: lift.value, reducedMotion });
        return { opacity: motion.opacity, transform: [{ translateY: motion.translateY }, { scale: motion.scale }] };
    }, [ghost, lift, reducedMotion]);
    const listStyle = useAnimatedStyle(() => ({ transform: [{ translateY: scroll.value }] }), [scroll]);
    const raisedStyle = useAnimatedStyle(() => {
        const at = index.value;
        const bottom = at >= 0 ? rowBottoms[at] : hereBottom;
        if (bottom === undefined || bottom === null) return { opacity: 0 };
        // Raised only once the panel is legible: early in the ghost the row still belongs to the list.
        return { opacity: ghost.value >= 1 || props.docked ? 1 : 0, transform: [{ translateY: -bottom }] };
    }, [ghost, hereBottom, index, props.docked, rowBottoms]);

    return (
        <Animated.View
            pointerEvents={props.docked ? 'box-none' : 'none'}
            accessibilityElementsHidden={!props.docked}
            importantForAccessibility={props.docked ? 'auto' : 'no-hide-descendants'}
            style={panelStyle}
            testID={SESSION_SWITCHER_PANEL_TEST_ID}
        >
            {props.selected && (props.selected.excerpt || props.selected.draft) ? (
                <SwitcherPeek row={props.selected} />
            ) : null}
            <GlassPanel radius={PANEL_RADIUS} style={styles.panel} surfaceColor={theme.colors.background.canvas}>
                {props.docked ? (
                    <View style={styles.dockedHeader}>
                        <Text style={styles.dockedTitle} accessibilityRole="header">{t('phoneNav.switcher.title')}</Text>
                        <Pressable style={styles.link} onPress={props.onAllSessions} accessibilityRole="link" hitSlop={8}>
                            <Text style={styles.linkText}>{t('phoneNav.switcher.allSessions')}</Text>
                            <Icon name="caret-right" size={14} color={theme.colors.text.link} />
                        </Pressable>
                    </View>
                ) : null}
                <View style={[styles.viewport, { height: props.viewportHeight - chromeHeight }]}>
                    <Animated.View style={[styles.list, { height: layout.contentHeight }, listStyle]}>
                        <Animated.View pointerEvents="none" style={[styles.raised, { bottom: 0 }, raisedStyle]} />
                        {layout.items.map((item) => {
                            if (item.kind === 'row' || item.kind === 'here') {
                                return (
                                    <SwitcherRow
                                        key={item.key}
                                        row={item.row}
                                        bottom={item.bottom}
                                        index={item.kind === 'row' ? item.index : -1}
                                        here={item.kind === 'here'}
                                        ghost={ghost}
                                        interactive={props.docked}
                                        onPress={props.onOpenRow}
                                    />
                                );
                            }
                            if (item.kind === 'heading') {
                                return (
                                    <View key={item.key} style={[styles.heading, { bottom: item.bottom }]}>
                                        <Text style={styles.headingText}>{headingLabel(item.heading)}</Text>
                                        {item.synced ? (
                                            <>
                                                <Text style={styles.headingMeta}>·</Text>
                                                <Icon name="arrows-clockwise" size={12} color={theme.colors.text.tertiary} />
                                                <Text style={styles.headingMeta}>{t('phoneNav.switcher.synced')}</Text>
                                            </>
                                        ) : null}
                                    </View>
                                );
                            }
                            return (
                                <View key={item.key} style={[styles.end, { bottom: item.bottom }]} accessibilityRole="text">
                                    <Icon name={item.direction === 'next' ? 'arrow-down' : 'arrow-up'} size={16} color={theme.colors.text.tertiary} />
                                    <View style={styles.body}>
                                        <Text style={styles.title}>
                                            {t(item.direction === 'next' ? 'phoneNav.switcher.noOlderSessions' : 'phoneNav.switcher.noNewerSessions')}
                                        </Text>
                                        <Text style={styles.status}>
                                            {t(item.source === 'list'
                                                ? (item.direction === 'next' ? 'phoneNav.switcher.lastInSessions' : 'phoneNav.switcher.firstInSessions')
                                                : (item.direction === 'next' ? 'phoneNav.switcher.nothingFurtherBack' : 'phoneNav.switcher.mostRecent'))}
                                        </Text>
                                    </View>
                                </View>
                            );
                        })}
                    </Animated.View>
                </View>
            </GlassPanel>
        </Animated.View>
    );
});

/** The thing itself, above the panel: where the selected row is, and the last thing said in it. */
const SwitcherPeek = React.memo(function SwitcherPeek(props: Readonly<{ row: SessionSwitcherRow }>) {
    const { theme } = useUnistyles();
    const { row } = props;
    const where = [row.status?.text, row.timeLabel].filter(Boolean).join(' · ');
    return (
        <View style={[styles.peek, { bottom: '100%', marginBottom: 10 }]} pointerEvents="none">
            <GlassPanel radius={20} surfaceColor={theme.colors.surface.base} style={{ paddingHorizontal: 14, paddingVertical: 10, gap: 4 }}>
                <View style={styles.peekWhere}>
                    <RowMark row={row} size={13} />
                    <Text style={styles.peekWhereText} numberOfLines={1}>{where || row.title}</Text>
                </View>
                {row.excerpt ? <Text style={styles.peekText} numberOfLines={3}>{row.excerpt}</Text> : null}
                {row.draft ? <Text style={styles.peekWhereText} numberOfLines={2}>{t('phoneNav.switcher.draft', { text: row.draft })}</Text> : null}
            </GlassPanel>
        </View>
    );
});

/**
 * "Stay on …": what letting go does when the thumb is back on the bar after the lock. It sits over
 * the bar's capsule, so the bar itself reads as the way back.
 */
export const SessionSwitcherStayPill = React.memo(function SessionSwitcherStayPill(props: Readonly<{ title: string }>) {
    const { theme } = useUnistyles();
    return (
        <SessionNavigationPill>
            <Icon name="arrow-down" size={14} color={theme.colors.text.secondary} />
            <Text style={sessionNavigationPillStyles.label} numberOfLines={1}>{t('phoneNav.switcher.stayOn')}</Text>
            <Text style={sessionNavigationPillStyles.title} numberOfLines={1}>{props.title}</Text>
        </SessionNavigationPill>
    );
});
