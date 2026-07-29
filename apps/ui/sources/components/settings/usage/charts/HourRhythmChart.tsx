import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ChartTooltip } from '@/components/ui/charts';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { UsageHourRhythm } from '@/sync/api/account/usageAnalytics';
import { usageSignatureAccent, withUsageAccentAlpha } from '../usageAccent';

/**
 * Band 3 "Daily rhythm": 24 slim hour-of-day columns on a hairline baseline. The
 * busiest hour is the full signature accent and labelled (`2 PM · busiest`); the
 * rest sit at a quiet accent alpha. Axis marks 12A · 6A · 12P · 6P (11px tabular
 * tertiary). Heights are static — the parent Band owns the entrance motion.
 */
export type HourRhythmChartProps = Readonly<{
    rhythm: UsageHourRhythm;
    testID?: string;
}>;

const BAR_AREA_HEIGHT = 52;
const MIN_BAR_HEIGHT = 2;
const AXIS_HOURS = [0, 6, 12, 18] as const;

/** Compact axis form: 0→"12A", 6→"6A", 12→"12P", 18→"6P". */
function formatAxisHour(hour: number): string {
    const period = hour < 12 ? 'A' : 'P';
    const base = hour % 12 === 0 ? 12 : hour % 12;
    return `${base}${period}`;
}

/** Full form for the busiest tag: 0→"12 AM", 13→"1 PM". */
function formatFullHour(hour: number): string {
    const period = hour < 12 ? 'AM' : 'PM';
    const base = hour % 12 === 0 ? 12 : hour % 12;
    return `${base} ${period}`;
}

export const HourRhythmChart = React.memo(function HourRhythmChart(props: HourRhythmChartProps) {
    const { theme } = useUnistyles();
    const { rhythm } = props;
    const accent = usageSignatureAccent(theme);
    const restFill = withUsageAccentAlpha(accent, 0.25);
    const peak = Math.max(1, rhythm.peakCount);

    return (
        <View style={styles.root} testID={props.testID}>
            {rhythm.busiestHour !== null ? (
                <Text style={styles.busiestTag} numberOfLines={1} testID="usage-rhythm-busiest">
                    <Text style={styles.busiestValue}>{formatFullHour(rhythm.busiestHour)}</Text>
                    {` · ${t('usage.busiestTag')}`}
                </Text>
            ) : null}
            <View style={[styles.barArea, { height: BAR_AREA_HEIGHT }]}>
                {rhythm.hours.map((bar) => {
                    const isPeak = bar.hour === rhythm.busiestHour && rhythm.busiestHour !== null;
                    const ratio = rhythm.peakCount > 0 ? bar.eventCount / peak : 0;
                    const height = bar.eventCount > 0
                        ? Math.max(MIN_BAR_HEIGHT, ratio * BAR_AREA_HEIGHT)
                        : MIN_BAR_HEIGHT;
                    return (
                        <View key={bar.hour} style={styles.barSlot}>
                            {/* Full-height trigger: hover/press anywhere in the
                                hour column opens the lens, not only the fill. */}
                            <ChartTooltip
                                triggerTestID="usage-rhythm-hour-trigger"
                                title={formatFullHour(bar.hour)}
                                value={`${bar.eventCount.toLocaleString()} ${t('usage.events')}`}
                                accentColor={accent}
                            >
                                <View style={styles.barHoverColumn}>
                                    <View
                                        style={{
                                            width: '100%',
                                            height,
                                            borderRadius: 2,
                                            backgroundColor: bar.eventCount > 0
                                                ? (isPeak ? accent : restFill)
                                                : theme.colors.border.default,
                                            opacity: bar.eventCount > 0 ? 1 : 0.5,
                                        }}
                                    />
                                </View>
                            </ChartTooltip>
                        </View>
                    );
                })}
            </View>
            <View style={[styles.baseline, { backgroundColor: theme.colors.border.default }]} />
            <View style={styles.axisRow}>
                {AXIS_HOURS.map((hour) => (
                    <Text key={hour} style={styles.axisLabel}>{formatAxisHour(hour)}</Text>
                ))}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    root: {
        gap: 6,
    },
    busiestTag: {
        ...Typography.default(),
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
    busiestValue: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    barArea: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: 2,
    },
    barSlot: {
        flex: 1,
        justifyContent: 'flex-end',
        alignItems: 'stretch',
    },
    // Fills the slot's full BAR_AREA_HEIGHT so the tooltip target is the whole
    // column; the visible fill stays bottom-anchored inside it.
    barHoverColumn: {
        height: BAR_AREA_HEIGHT,
        justifyContent: 'flex-end',
    },
    baseline: {
        height: StyleSheet.hairlineWidth,
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
}));
