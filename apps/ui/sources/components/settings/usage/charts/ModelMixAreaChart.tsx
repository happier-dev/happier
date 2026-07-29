import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Path, Svg } from 'react-native-svg';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ChartTooltip } from '@/components/ui/charts';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { INSTRUMENT_DURATIONS, useMotionPreferences } from '@/components/instrument';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { formatTokenCount } from '@/utils/format/usageNumbers';
import type { UsageModelMix } from '@/sync/api/account/usageAnalytics';
import { usageSeriesColor, usageSignatureAccent, withUsageAccentAlpha } from '../usageAccent';
import { useEntrancesEnabled } from '../sections/EntranceView';
import { buildStackedAreaBands } from './stackedAreaPath';

/**
 * Model-mix (or engine-mix) 100%-stacked share AREA chart over time (B-1) — the
 * centerpiece addition. Smooth accent-ramp ribbons (no dot plots), an anchored
 * 0/50/100% share axis, per-bucket `ChartTooltip`, and a legend of the top
 * series by overall share. Colours come exclusively from the usageAccent ramp;
 * entrance fades in once (motion-gated, entrance-once via `EntranceView`).
 */
export type ModelMixAreaChartProps = Readonly<{
    mix: UsageModelMix;
    testID?: string;
}>;

const AREA_HEIGHT = 150;
// Top+bottom inset so the 100%/0% bands never kiss the container edge.
const AREA_INSET = 4;
// Right gutter that holds the % axis labels OUTSIDE the plot fill (matches the
// flow chart's right-side label convention, but reserved so the teal never sits
// under the labels — R5 frame-review fix).
const AXIS_GUTTER = 40;

function seriesLabel(label: string): string {
    return label.length > 0 ? label : t('usage.modelMix.other');
}

function formatBucketDate(startMs: number): string {
    return formatWithCachedDateTimeFormatter(new Date(startMs), undefined, { month: 'short', day: 'numeric' });
}

const GRID = [
    { key: 'top', share: 1, label: '100%' },
    { key: 'mid', share: 0.5, label: '50%' },
    { key: 'base', share: 0, label: '0%' },
] as const;

export const ModelMixAreaChart = React.memo(function ModelMixAreaChart(props: ModelMixAreaChartProps) {
    const { theme } = useUnistyles();
    const motion = useMotionPreferences();
    const entrancesEnabled = useEntrancesEnabled();
    const [width, setWidth] = React.useState(0);

    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = event.nativeEvent.layout.width;
        setWidth((current) => (Math.abs(current - next) < 0.5 ? current : next));
    }, []);

    const plotWidth = width > 0 ? Math.max(0, width - AXIS_GUTTER) : 0;
    const bands = React.useMemo(
        () => (plotWidth > 0 ? buildStackedAreaBands(props.mix, { width: plotWidth, height: AREA_HEIGHT, inset: AREA_INSET }) : []),
        [props.mix, plotWidth],
    );

    const animateEntrance = entrancesEnabled && motion.level !== 'minimal';
    const opacity = useSharedValue(animateEntrance ? 0 : 1);
    React.useEffect(() => {
        if (!animateEntrance) return;
        opacity.value = withTiming(1, { duration: INSTRUMENT_DURATIONS.entranceEmphasis });
        // Entrance plays once per mount by design.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const areaStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

    const buckets = props.mix.buckets;
    const accent = usageSignatureAccent(theme);

    const resolveBucketTooltip = React.useCallback((index: number) => {
        const bucket = buckets[index];
        if (!bucket) return null;
        // The dominant series in this bucket + its share (the single ChartTooltip value).
        let topShare = -1;
        let topIndex = 0;
        bucket.shares.forEach((share, i) => {
            if (share > topShare) {
                topShare = share;
                topIndex = i;
            }
        });
        const topKey = props.mix.keys[topIndex];
        return {
            title: formatBucketDate(bucket.startMs),
            subtitle: topKey ? seriesLabel(topKey.label) : undefined,
            value: bucket.total > 0 ? `${Math.round((topShare > 0 ? topShare : 0) * 100)}%` : '—',
        };
    }, [buckets, props.mix.keys]);

    const legendKeys = props.mix.keys;

    return (
        <View style={styles.root} testID={props.testID}>
            <View style={styles.chartArea} onLayout={onLayout}>
                {GRID.map((line) => (
                    <View
                        key={line.key}
                        pointerEvents="none"
                        style={[
                            styles.gridLine,
                            line.key === 'base' ? null : styles.gridLineQuiet,
                            { right: AXIS_GUTTER, top: AREA_INSET + (1 - line.share) * (AREA_HEIGHT - AREA_INSET * 2) },
                        ]}
                    />
                ))}
                {plotWidth > 0 ? (
                    <Animated.View style={areaStyle} pointerEvents="none">
                        <Svg width={plotWidth} height={AREA_HEIGHT}>
                            {bands.map((band) => (
                                <Path
                                    key={band.key}
                                    d={band.path}
                                    fill={usageSeriesColor(theme, band.rampIndex)}
                                />
                            ))}
                        </Svg>
                    </Animated.View>
                ) : null}
                {/* Per-bucket tooltip columns (B-1: ChartTooltip per bucket), over the plot only. */}
                <View style={[styles.tooltipRow, { right: AXIS_GUTTER }]} pointerEvents="box-none">
                    {buckets.map((bucket, index) => {
                        const content = resolveBucketTooltip(index);
                        if (!content) return null;
                        return (
                            <ChartTooltip
                                key={`${bucket.startMs}-${index}`}
                                triggerTestID="usage-model-mix-bucket-trigger"
                                title={content.title}
                                subtitle={content.subtitle}
                                value={content.value}
                                accentColor={accent}
                                triggerStyle={styles.tooltipColumn}
                            >
                                <View style={styles.tooltipFill} />
                            </ChartTooltip>
                        );
                    })}
                </View>
                {GRID.map((line) => (
                    <Text
                        key={`${line.key}-label`}
                        style={[
                            styles.gridLabel,
                            { top: Math.max(0, Math.min(AREA_HEIGHT - 14, AREA_INSET + (1 - line.share) * (AREA_HEIGHT - AREA_INSET * 2) - 6)) },
                        ]}
                    >
                        {line.label}
                    </Text>
                ))}
            </View>
            {buckets.length > 1 ? (
                <View style={[styles.axisRow, { paddingRight: AXIS_GUTTER }]}>
                    <Text style={styles.axisLabel}>{formatBucketDate(buckets[0]!.startMs)}</Text>
                    <Text style={styles.axisLabel}>{formatBucketDate(buckets[buckets.length - 1]!.startMs)}</Text>
                </View>
            ) : null}
            <View style={styles.legend}>
                {legendKeys.map((key, index) => {
                    const sharePct = props.mix.total > 0 ? (key.totalTokens / props.mix.total) * 100 : 0;
                    return (
                        <View key={key.key} style={styles.legendItem}>
                            <View style={[styles.swatch, { backgroundColor: usageSeriesColor(theme, index) }]} />
                            <Text style={styles.legendLabel} numberOfLines={1}>{seriesLabel(key.label)}</Text>
                            <View style={[styles.pill, { backgroundColor: withUsageAccentAlpha(accent, 0.12) }]}>
                                <Text style={[styles.pillText, { color: accent }]}>
                                    {sharePct > 0 && sharePct < 1 ? '<1%' : `${Math.round(sharePct)}%`}
                                </Text>
                            </View>
                            <Text style={styles.legendValue} numberOfLines={1}>
                                {formatTokenCount(key.totalTokens)}
                            </Text>
                        </View>
                    );
                })}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    root: {
        gap: 12,
    },
    chartArea: {
        position: 'relative',
        height: AREA_HEIGHT,
    },
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
    tooltipRow: {
        ...StyleSheet.absoluteFillObject,
        flexDirection: 'row',
    },
    tooltipColumn: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
    },
    tooltipFill: {
        flex: 1,
    },
    axisRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
    axisLabel: {
        ...Typography.default(),
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
    legend: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        rowGap: 8,
    },
    legendItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        width: '50%',
        paddingRight: 8,
    },
    swatch: {
        width: 8,
        height: 8,
        borderRadius: 2,
    },
    legendLabel: {
        ...Typography.default(),
        flexShrink: 1,
        fontSize: 13,
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
    pill: {
        borderRadius: 4,
        paddingHorizontal: 5,
        paddingVertical: 1,
    },
    pillText: {
        ...Typography.default('semiBold'),
        fontSize: 11,
        lineHeight: 14,
        fontVariant: ['tabular-nums'],
    },
    legendValue: {
        ...Typography.default(),
        marginLeft: 'auto',
        fontSize: 13,
        lineHeight: 16,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
}));
