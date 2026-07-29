import * as React from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { formatTokenCount } from '@/utils/format/usageNumbers';
import type { UsageContextTokenMix } from '@/sync/api/account/usageAnalytics';
import { usageSeriesColor } from '../usageAccent';

/**
 * Static segmented donut for the session token mix (input / output / reasoning
 * / cache read / cache write). Not a progress ring — a composition breakdown —
 * so it deliberately does not reuse ContextGauge/TokenUsageRing (different
 * bounded context; see REUSE-CONTRACT "usage ring"). Fully static: no
 * animation, instantly scannable (day-to-day rule).
 */

export type TokenMixDonutProps = Readonly<{
    mix: UsageContextTokenMix;
    size?: number;
    testID?: string;
}>;

const STROKE_WIDTH = 10;

const styles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 20,
        flexWrap: 'wrap',
    },
    legend: {
        gap: 8,
        flexShrink: 1,
        minWidth: 140,
    },
    legendRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    legendSwatch: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    legendLabel: {
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    legendValue: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
}));

export const TokenMixDonut: React.FC<TokenMixDonutProps> = ({ mix, size = 96, testID }) => {
    const { theme } = useUnistyles();

    const segments = [
        // ONE-accent system (D-1/D-6): segments are ordered, distinct tonal
        // steps of the single signature accent.
        { key: 'input', label: t('usage.tokenMix.input'), value: mix.input, color: usageSeriesColor(theme, 0) },
        { key: 'output', label: t('usage.tokenMix.output'), value: mix.output, color: usageSeriesColor(theme, 1) },
        { key: 'reasoning', label: t('usage.tokenMix.reasoning'), value: mix.reasoning, color: usageSeriesColor(theme, 2) },
        { key: 'cacheRead', label: t('usage.tokenMix.cacheRead'), value: mix.cacheRead, color: usageSeriesColor(theme, 3) },
        { key: 'cacheWrite', label: t('usage.tokenMix.cacheWrite'), value: mix.cacheWrite, color: usageSeriesColor(theme, 4) },
    ].filter((segment) => segment.value > 0);

    const total = segments.reduce((sum, segment) => sum + segment.value, 0);
    if (total <= 0 || segments.length === 0) {
        return null;
    }

    const radius = (size - STROKE_WIDTH) / 2;
    const circumference = 2 * Math.PI * radius;
    const gapLength = segments.length > 1 ? 2 : 0;

    let offset = 0;
    const arcs = segments.map((segment) => {
        const fraction = segment.value / total;
        const arcLength = Math.max(0, fraction * circumference - gapLength);
        const arc = {
            ...segment,
            dashArray: `${arcLength} ${circumference - arcLength}`,
            dashOffset: -offset,
        };
        offset += fraction * circumference;
        return arc;
    });

    return (
        <View style={styles.row} testID={testID}>
            <Svg width={size} height={size}>
                {arcs.map((arc) => (
                    <Circle
                        key={arc.key}
                        cx={size / 2}
                        cy={size / 2}
                        r={radius}
                        stroke={arc.color}
                        strokeWidth={STROKE_WIDTH}
                        strokeDasharray={arc.dashArray}
                        strokeDashoffset={arc.dashOffset}
                        strokeLinecap="butt"
                        fill="none"
                        transform={`rotate(-90 ${size / 2} ${size / 2})`}
                    />
                ))}
            </Svg>
            <View style={styles.legend}>
                {segments.map((segment) => (
                    <View key={segment.key} style={styles.legendRow}>
                        <View style={[styles.legendSwatch, { backgroundColor: segment.color }]} />
                        <Text style={styles.legendLabel} numberOfLines={1}>
                            {segment.label}
                        </Text>
                        <Text style={styles.legendValue}>{formatTokenCount(segment.value)}</Text>
                    </View>
                ))}
            </View>
        </View>
    );
};
