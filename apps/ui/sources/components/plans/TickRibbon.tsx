import * as React from 'react';
import { View } from 'react-native';
import Svg, { Line, Path } from 'react-native-svg';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/** One session in the window: when it was last active, how much it ran, and its fate. */
export type RibbonTick = Readonly<{
    atMs: number;
    messages: number;
    pinned: boolean;
    leaving: boolean;
}>;

export type TickRibbonProps = Readonly<{
    ticks: readonly RibbonTick[];
    nowMs: number;
    /** The server's window (90 days). */
    windowDays: number;
    /** The plan's session period; the edge is drawn only when it falls inside the window. */
    retentionDays: number | null;
    width: number;
    compact?: boolean;
}>;

const DAY_MS = 86_400_000;
const PLOT_HEIGHT = 92;
const TICK_WIDTH = 2;
const MIN_TICK = 8;
const DOT_RADIUS = 2.6;
const DOT_GAP = 6;

type RibbonPaths = Readonly<{ current: string; older: string; leaving: string; dots: string }>;

/**
 * Builds every mark as part of one path per tone, so a thousand sessions are four SVG nodes and
 * nothing animates per tick. Height is message count on a log scale.
 */
function buildRibbonPaths(params: Readonly<{ ticks: readonly RibbonTick[]; nowMs: number; windowDays: number; edgeMs: number | null; width: number }>): RibbonPaths {
    const windowStart = params.nowMs - params.windowDays * DAY_MS;
    const span = params.windowDays * DAY_MS;
    const maxMessages = params.ticks.reduce((max, tick) => Math.max(max, tick.messages), 1);
    const scale = Math.log1p(maxMessages);
    const usable = PLOT_HEIGHT - DOT_GAP - DOT_RADIUS * 2;
    let current = '';
    let older = '';
    let leaving = '';
    let dots = '';
    for (const tick of params.ticks) {
        if (tick.atMs < windowStart) continue;
        const x = Math.min(params.width - TICK_WIDTH, Math.max(0, ((tick.atMs - windowStart) / span) * (params.width - TICK_WIDTH)));
        const height = MIN_TICK + (usable - MIN_TICK) * (Math.log1p(Math.max(0, tick.messages)) / scale);
        const top = PLOT_HEIGHT - height;
        if (tick.leaving) {
            leaving += `M${(x + 0.5).toFixed(1)} ${PLOT_HEIGHT}V${top.toFixed(1)}H${(x + TICK_WIDTH - 0.5).toFixed(1)}V${PLOT_HEIGHT}`;
        } else {
            const mark = `M${x.toFixed(1)} ${PLOT_HEIGHT}V${top.toFixed(1)}h${TICK_WIDTH}V${PLOT_HEIGHT}Z`;
            if (params.edgeMs !== null && tick.atMs < params.edgeMs) older += mark;
            else current += mark;
        }
        if (tick.pinned) {
            const cx = x + TICK_WIDTH / 2;
            const cy = top - DOT_GAP;
            dots += `M${(cx - DOT_RADIUS).toFixed(1)} ${cy.toFixed(1)}a${DOT_RADIUS} ${DOT_RADIUS} 0 1 0 ${DOT_RADIUS * 2} 0a${DOT_RADIUS} ${DOT_RADIUS} 0 1 0 ${-DOT_RADIUS * 2} 0`;
        }
    }
    return { current, older, leaving, dots };
}

/**
 * The history ribbon on Plans & Supporter (plan 04 U3): one mark per session over the window, pins
 * as gold dots, sessions leaving soon as outlines, and the retention edge where it falls inside.
 * Screen readers get the counts, not the marks.
 */
export const TickRibbon = React.memo(function TickRibbon(props: TickRibbonProps) {
    const { theme } = useUnistyles();
    const windowStart = props.nowMs - props.windowDays * DAY_MS;
    const edgeMs = props.retentionDays !== null && props.retentionDays < props.windowDays
        ? props.nowMs - props.retentionDays * DAY_MS
        : null;
    const paths = React.useMemo(
        () => buildRibbonPaths({ ticks: props.ticks, nowMs: props.nowMs, windowDays: props.windowDays, edgeMs, width: props.width }),
        [edgeMs, props.nowMs, props.ticks, props.width, props.windowDays],
    );
    const counts = React.useMemo(() => ({
        sessions: props.ticks.filter((tick) => tick.atMs >= windowStart).length,
        pinned: props.ticks.filter((tick) => tick.pinned).length,
        leaving: props.ticks.filter((tick) => tick.leaving).length,
    }), [props.ticks, windowStart]);
    const edgeX = edgeMs === null ? null : ((edgeMs - windowStart) / (props.windowDays * DAY_MS)) * props.width;
    const thirtyX = ((props.windowDays - 30) / props.windowDays) * props.width;
    const short = props.compact === true;

    return (
        <View accessible accessibilityRole="image" accessibilityLabel={t('planSurface.ribbonA11y', counts)} testID="tick-ribbon">
            {props.width > 0 ? (
                <Svg width={props.width} height={PLOT_HEIGHT}>
                    <Line x1={0} y1={PLOT_HEIGHT - 0.5} x2={props.width} y2={PLOT_HEIGHT - 0.5} stroke={theme.colors.border.default} strokeWidth={1} />
                    {edgeX !== null ? (
                        <Line testID="tick-ribbon-edge" x1={edgeX} y1={0} x2={edgeX} y2={PLOT_HEIGHT} stroke={theme.colors.text.tertiary} strokeWidth={1} strokeDasharray="2 3" />
                    ) : null}
                    {paths.older ? <Path d={paths.older} fill={theme.colors.text.tertiary} opacity={0.6} /> : null}
                    {paths.current ? <Path d={paths.current} fill={theme.colors.text.primary} /> : null}
                    {paths.leaving ? <Path d={paths.leaving} fill="none" stroke={theme.colors.text.secondary} strokeWidth={1} /> : null}
                    {paths.dots ? <Path d={paths.dots} fill={theme.colors.supporter.accent} /> : null}
                </Svg>
            ) : <View style={{ height: PLOT_HEIGHT }} />}
            {counts.sessions === 0 ? <Text style={styles.empty}>{t('planSurface.ribbonEmpty')}</Text> : null}
            <View style={styles.axis} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                <Text style={styles.axisLabel}>{short ? t('planSurface.daysShort', { count: props.windowDays }) : t('planSurface.ribbonAxisStart', { days: props.windowDays })}</Text>
                {edgeX !== null && props.retentionDays !== null ? (
                    <Text style={[styles.axisLabel, styles.axisFloating, { left: Math.max(0, edgeX - 40) }]}>
                        {short ? t('planSurface.daysShort', { count: props.retentionDays }) : t('planSurface.ribbonEdge', { days: props.retentionDays })}
                    </Text>
                ) : null}
                <Text style={[styles.axisLabel, styles.axisFloating, { left: thirtyX - 14 }]}>{short ? t('planSurface.daysShort', { count: 30 }) : t('planSurface.days', { count: 30 })}</Text>
                <View style={styles.grow} />
                <Text style={styles.axisLabel}>{t('planSurface.ribbonAxisToday')}</Text>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    axis: {
        flexDirection: 'row',
        marginTop: 10,
        height: 18,
    },
    axisLabel: {
        ...Typography.mono(),
        fontSize: 12,
        color: theme.colors.text.tertiary,
    },
    axisFloating: {
        position: 'absolute',
        top: 0,
    },
    grow: {
        flex: 1,
    },
    empty: {
        ...Typography.default(),
        position: 'absolute',
        top: PLOT_HEIGHT / 2 - 10,
        alignSelf: 'center',
        fontSize: 14,
        color: theme.colors.text.secondary,
    },
}));
