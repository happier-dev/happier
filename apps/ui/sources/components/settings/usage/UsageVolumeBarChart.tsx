import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withSpring,
    withTiming,
} from 'react-native-reanimated';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { ChartTooltip, HorizontalChartFrame } from '@/components/ui/charts';
import { INSTRUMENT_SPRINGS, useMotionPreferences } from '@/components/instrument';
import type { UsageMetric, UsageTrendPoint } from '@/sync/api/account/usageAnalytics';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { formatTokenCount, formatTokenCountLong, formatUsageCost } from '@/utils/format/usageNumbers';
import { usageSignatureAccent } from './usageAccent';
import { useEntrancesEnabled } from './sections/EntranceView';
import { ScrubLens } from './sections/ScrubLens';

type UsageVolumeBarChartProps = Readonly<{
    points: readonly UsageTrendPoint[];
    metric: UsageMetric;
    currency?: string;
    testID?: string;
}>;

const MAX_POINTS = 30;
// Grow-in choreography (lane contract): 350ms height grow from the baseline,
// 30ms stagger, stagger budget capped so long series never accumulate an
// unbounded wait.
const GROW_DURATION_MS = 350;
const GROW_STAGGER_MS = 30;
const GROW_STAGGER_CAP = 8;

// Deterministic vertical geometry (D-R3-4): the gridline overlay maps values to
// pixels truthfully only because these are fixed. The tallest bar is exactly
// BAR_AREA_HEIGHT tall; the zero line is the shared baseline all bars rise from.
const BAR_AREA_HEIGHT = 150;
const VALUE_ROW_HEIGHT = 16;
const BAR_PAD_TOP = 16;
const BAR_PAD_BOTTOM = 10;
const LABEL_ROW_HEIGHT = 20;
const BASELINE_BOTTOM = LABEL_ROW_HEIGHT + BAR_PAD_BOTTOM;

/**
 * One bar fill. Entrance: grows in once on mount (bottom-anchored, motion-gated).
 * Afterwards, height CHANGES morph in place with the standard spring — the
 * period-change re-interpolation (D-R3-5 / D-R2-9), never a remount hard-swap.
 * At the minimal motion level both are skipped and the bar renders statically.
 */
const MorphingBar: React.FC<Readonly<{
    index: number;
    height: number;
    color: string;
    opacity: number;
    entrance: boolean;
    morph: boolean;
    testID?: string;
}>> = ({ index, height, color, opacity, entrance, morph, testID }) => {
    const animatedHeight = useSharedValue(entrance ? 0 : height);
    const mountedRef = React.useRef(false);

    React.useEffect(() => {
        if (!mountedRef.current) {
            mountedRef.current = true;
            if (entrance) {
                const delay = Math.min(index, GROW_STAGGER_CAP - 1) * GROW_STAGGER_MS;
                animatedHeight.value = withDelay(delay, withTiming(height, { duration: GROW_DURATION_MS }));
            }
            return;
        }
        animatedHeight.value = morph
            ? withSpring(height, INSTRUMENT_SPRINGS.standard)
            : height;
        // Entrance plays once; afterwards only `height` re-targets the value.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [height]);

    const animatedStyle = useAnimatedStyle(() => ({
        height: animatedHeight.value,
    }));

    if (!entrance && !morph) {
        return (
            <View
                testID={testID}
                style={[styles.barAnchor, { height, backgroundColor: color, opacity }]}
            />
        );
    }

    return (
        <Animated.View
            testID={testID}
            style={[
                styles.barAnchor,
                { backgroundColor: color, opacity },
                animatedStyle,
            ]}
        />
    );
};

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 14,
    },
    emptyState: {
        paddingVertical: 28,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyText: {
        fontSize: 14,
        color: theme.colors.text.secondary,
    },
    chartArea: {
        position: 'relative',
    },
    // D-R3-4: 3 horizontal hairlines (0 / mid / max) spanning the full band
    // width, BEHIND the scrolling bars; 11px tabular labels at the right edge.
    gridLine: {
        position: 'absolute',
        left: 0,
        right: 0,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.border.default,
    },
    gridLineQuiet: {
        opacity: 0.55,
    },
    gridLabel: {
        position: 'absolute',
        right: 4,
        ...Typography.default(),
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
    chartCanvas: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingHorizontal: 4,
        gap: 10,
    },
    column: {
        width: 42,
        alignItems: 'center',
        position: 'relative',
    },
    valueLabel: {
        minHeight: VALUE_ROW_HEIGHT,
        ...Typography.default('semiBold'),
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    barWrap: {
        width: '100%',
        height: BAR_PAD_TOP + BAR_AREA_HEIGHT + BAR_PAD_BOTTOM,
        justifyContent: 'flex-end',
        alignItems: 'center',
        paddingBottom: BAR_PAD_BOTTOM,
        paddingTop: BAR_PAD_TOP,
    },
    barTrack: {
        width: 26,
        height: BAR_AREA_HEIGHT,
        justifyContent: 'flex-end',
        borderTopLeftRadius: 5,
        borderTopRightRadius: 5,
        backgroundColor: theme.colors.surface.inset,
        overflow: 'hidden',
    },
    barAnchor: {
        width: '100%',
        borderTopLeftRadius: 5,
        borderTopRightRadius: 5,
    },
    // Fills the track's full BAR_AREA_HEIGHT so the tooltip target is the whole
    // column; the animated fill stays bottom-anchored inside it.
    barHoverColumn: {
        height: BAR_AREA_HEIGHT,
        justifyContent: 'flex-end',
    },
    label: {
        marginTop: 6,
        height: LABEL_ROW_HEIGHT - 6,
        ...Typography.default(),
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
    footer: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 12,
        paddingHorizontal: 6,
    },
    footerMetric: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
    footerValue: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
}));

function formatMetricValue(value: number, metric: UsageMetric, currency: string): string {
    if (metric === 'cost') {
        return formatUsageCost(value, currency);
    }
    return formatTokenCount(value);
}

function formatBucketLabel(timestampSeconds: number, pointCount: number): string {
    const date = new Date(timestampSeconds * 1000);
    if (pointCount <= 8) {
        return formatWithCachedDateTimeFormatter(date, undefined, { month: 'short', day: 'numeric' });
    }
    return formatWithCachedDateTimeFormatter(date, undefined, { month: 'short' });
}

function getPointValue(point: UsageTrendPoint, metric: UsageMetric): number {
    return metric === 'cost' ? point.cost : point.tokens;
}

export function UsageVolumeBarChart(props: UsageVolumeBarChartProps): React.ReactElement {
    const { points, metric, currency = 'USD', testID } = props;
    const { theme } = useUnistyles();
    const motion = useMotionPreferences();
    // Single guard source (R-L6 F1): no grow-in replay on a revisit remount.
    const entrancesEnabled = useEntrancesEnabled();

    // The scrub lens reads point values lazily by index.
    const displayPoints = React.useMemo(
        () => (points.length > MAX_POINTS ? points.slice(-MAX_POINTS) : [...points]),
        [points],
    );
    const resolveLensContent = React.useCallback((index: number) => {
        const point = displayPoints[index];
        if (!point) return null;
        return {
            title: formatBucketLabel(point.timestamp, displayPoints.length),
            rows: [
                { label: t('usage.tokens'), value: formatTokenCountLong(point.tokens) },
                { label: t('usage.cost'), value: formatUsageCost(point.cost, currency) },
                { label: t('usage.events'), value: point.reportCount.toLocaleString() },
            ],
        };
    }, [currency, displayPoints]);

    if (points.length === 0) {
        return (
            <View style={styles.emptyState}>
                <Text style={styles.emptyText}>{t('usage.noData.title')}</Text>
            </View>
        );
    }

    const maxValue = Math.max(...displayPoints.map((point) => getPointValue(point, metric)), 1);
    // ONE signature accent (D-1); resting-state bars must be legible (D-3).
    const accentColor = usageSignatureAccent(theme);
    const topPoint = [...displayPoints].sort((left, right) => getPointValue(right, metric) - getPointValue(left, metric))[0] ?? null;
    const total = displayPoints.reduce((sum, point) => sum + getPointValue(point, metric), 0);
    const contentWidth = Math.max(640, displayPoints.length * 58 + 18);
    const animateEntrance = motion.entrance.kind === 'travel' && entrancesEnabled;
    const morphEnabled = motion.level !== 'minimal';

    // The max hairline stays (anchored top), but its right-edge VALUE label is
    // intentionally omitted: it always equals the inline peak annotation above
    // the peak column (peak === max by definition), so labelling both renders
    // the same number twice. The inline annotation at the peak column wins; the
    // axis keeps only the 0 and mid labels (orchestrator FINAL micro-fix,
    // superseding the D-R3-4 "0/mid/max labels" wording for this collision).
    const gridLines = [
        { key: 'zero', testID: 'usage-volume-grid-zero', bottom: BASELINE_BOTTOM, label: '0', quiet: false, showLabel: true },
        { key: 'mid', testID: 'usage-volume-grid-mid', bottom: BASELINE_BOTTOM + BAR_AREA_HEIGHT / 2, label: formatMetricValue(maxValue / 2, metric, currency), quiet: true, showLabel: true },
        { key: 'max', testID: 'usage-volume-grid-max', bottom: BASELINE_BOTTOM + BAR_AREA_HEIGHT, label: formatMetricValue(maxValue, metric, currency), quiet: true, showLabel: false },
    ] as const;

    return (
        <View testID={testID} style={styles.container}>
            <View style={styles.chartArea}>
                {gridLines.map((line) => (
                    <View
                        key={line.key}
                        testID={line.testID}
                        pointerEvents="none"
                        style={[styles.gridLine, line.quiet ? styles.gridLineQuiet : null, { bottom: line.bottom }]}
                    />
                ))}
                <HorizontalChartFrame contentWidth={contentWidth}>
                    <ScrubLens
                        testID={testID ? `${testID}-scrub` : undefined}
                        layout={{ leadingPx: 4, cellPx: 42, gapPx: 10, count: displayPoints.length }}
                        resolveContent={resolveLensContent}
                        accentColor={accentColor}
                    >
                        <View style={styles.chartCanvas}>
                            {displayPoints.map((point, index) => {
                                const value = getPointValue(point, metric);
                                const ratio = maxValue <= 0 ? 0 : value / maxValue;
                                const barHeight = Math.max(10, Math.round(ratio * BAR_AREA_HEIGHT));
                                const isTopPoint = topPoint != null && point.timestamp === topPoint.timestamp && value === getPointValue(topPoint, metric);

                                return (
                                    // Index-keyed on purpose: bars keep their identity
                                    // across period changes so heights MORPH in place
                                    // instead of remounting (D-R3-5).
                                    <View key={index} style={styles.column}>
                                        <Text
                                            testID={isTopPoint ? 'usage-volume-peak-annotation' : undefined}
                                            style={styles.valueLabel}
                                        >{isTopPoint ? formatMetricValue(value, metric, currency) : ' '}</Text>
                                        <View style={styles.barWrap}>
                                            <View style={styles.barTrack}>
                                                <ChartTooltip
                                                    triggerTestID="usage-volume-point-trigger"
                                                    title={formatBucketLabel(point.timestamp, displayPoints.length)}
                                                    subtitle={metric === 'cost' ? t('usage.cost') : t('usage.tokens')}
                                                    value={formatMetricValue(value, metric, currency)}
                                                    accentColor={accentColor}
                                                >
                                                    {/* Full-height hover column (D-R4-3): the tooltip
                                                        target is the whole 150px track, not only the
                                                        (possibly 10px) fill. */}
                                                    <View style={styles.barHoverColumn}>
                                                        <MorphingBar
                                                            testID={`usage-volume-point-anchor-${index}`}
                                                            index={index}
                                                            height={barHeight}
                                                            color={accentColor}
                                                            opacity={isTopPoint ? 1 : Math.max(0.55, ratio * 0.9)}
                                                            entrance={animateEntrance}
                                                            morph={morphEnabled}
                                                        />
                                                    </View>
                                                </ChartTooltip>
                                            </View>
                                        </View>
                                        <Text numberOfLines={1} style={styles.label}>
                                            {formatBucketLabel(point.timestamp, displayPoints.length)}
                                        </Text>
                                    </View>
                                );
                            })}
                        </View>
                    </ScrubLens>
                </HorizontalChartFrame>
                {gridLines.filter((line) => line.showLabel).map((line) => (
                    <Text
                        key={`${line.key}-label`}
                        testID={`${line.testID}-label`}
                        style={[styles.gridLabel, { bottom: line.bottom + 2 }]}
                    >
                        {line.label}
                    </Text>
                ))}
            </View>

            <View style={styles.footer}>
                <Text style={styles.footerMetric}>
                    {metric === 'cost' ? t('usage.totalCost') : t('usage.totalTokens')}: <Text style={styles.footerValue}>{formatMetricValue(total, metric, currency)}</Text>
                </Text>
                {topPoint ? (
                    <Text style={styles.footerMetric}>
                        {formatBucketLabel(topPoint.timestamp, displayPoints.length)} · <Text style={styles.footerValue}>{formatMetricValue(getPointValue(topPoint, metric), metric, currency)}</Text>
                    </Text>
                ) : null}
            </View>
        </View>
    );
}
