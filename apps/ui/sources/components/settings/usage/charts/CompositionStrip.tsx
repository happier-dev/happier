import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ChartTooltip } from '@/components/ui/charts';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { formatTokenCount, formatTokenCountLong } from '@/utils/format/usageNumbers';
import type { UsageComposition, UsageCompositionKey } from '@/sync/api/account/usageAnalytics';
import { usageSeriesColor, usageSignatureAccent, withUsageAccentAlpha } from '../usageAccent';

/**
 * Band 5 "What": one 12px 100%-stacked token-mix bar in the ordered accent ramp
 * (each present segment ≥2px), with a two-column legend of label + share pill +
 * exact tokens beneath. Segment order === ramp order, so segment N takes
 * `usageSeriesColor(theme, N)`.
 */
export type CompositionStripProps = Readonly<{
    composition: UsageComposition;
    testID?: string;
}>;

function compositionLabel(key: UsageCompositionKey): string {
    switch (key) {
        case 'input':
            return t('usage.tokenMix.input');
        case 'output':
            return t('usage.tokenMix.output');
        case 'cacheRead':
            return t('usage.tokenMix.cacheRead');
        case 'cacheWrite':
            return t('usage.tokenMix.cacheWrite');
        case 'reasoning':
            return t('usage.tokenMix.reasoning');
    }
}

function formatSharePct(pct: number): string {
    if (pct > 0 && pct < 1) {
        return '<1%';
    }
    return `${Math.round(pct)}%`;
}

export const CompositionStrip = React.memo(function CompositionStrip(props: CompositionStripProps) {
    const { theme } = useUnistyles();
    const accent = usageSignatureAccent(theme);
    const present = props.composition.segments
        .map((segment, index) => ({ ...segment, rampIndex: index }))
        .filter((segment) => segment.tokens > 0);

    return (
        <View style={styles.root} testID={props.testID}>
            <View style={[styles.bar, { backgroundColor: theme.colors.surface.base }]}>
                {present.map((segment) => (
                    <ChartTooltip
                        key={segment.key}
                        triggerTestID="usage-composition-segment-trigger"
                        title={compositionLabel(segment.key)}
                        subtitle={formatSharePct(segment.pct)}
                        value={formatTokenCountLong(segment.tokens)}
                        accentColor={usageSeriesColor(theme, segment.rampIndex)}
                        // The segment's flex share moves onto the trigger wrapper
                        // so wrapping never changes the 100%-stacked layout.
                        triggerStyle={{ flexGrow: Math.max(segment.pct, 0.5), minWidth: 2 }}
                    >
                        <View
                            style={{
                                height: '100%',
                                backgroundColor: usageSeriesColor(theme, segment.rampIndex),
                            }}
                        />
                    </ChartTooltip>
                ))}
            </View>
            <View style={styles.legend}>
                {present.map((segment) => (
                    <View key={segment.key} style={styles.legendItem}>
                        <View
                            style={[styles.swatch, { backgroundColor: usageSeriesColor(theme, segment.rampIndex) }]}
                        />
                        <Text style={styles.legendLabel} numberOfLines={1}>
                            {compositionLabel(segment.key)}
                        </Text>
                        <View style={[styles.pill, { backgroundColor: withUsageAccentAlpha(accent, 0.12) }]}>
                            <Text style={[styles.pillText, { color: accent }]}>{formatSharePct(segment.pct)}</Text>
                        </View>
                        <Text style={styles.legendValue} numberOfLines={1}>{formatTokenCount(segment.tokens)}</Text>
                    </View>
                ))}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    root: {
        gap: 12,
    },
    bar: {
        flexDirection: 'row',
        height: 12,
        borderRadius: 6,
        overflow: 'hidden',
        gap: 1,
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
