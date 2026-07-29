import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { TokenUsageRing } from '@/components/sessions/usage/TokenUsageRing';
import { formatPercent, formatUsageCost } from '@/utils/format/usageNumbers';
import type { UsageEfficiencyViewModel } from '@/sync/api/account/usageAnalytics';

/**
 * Band 6 "Efficiency" headlines (E-3): the loved cache-hit-rate ring (reusing
 * the canonical `TokenUsageRing`) and the effective $/Mtok stat, each with a
 * plain-language one-line caption, beside the existing cache-savings row. Both
 * figures come from the single view-model owner and render nothing when their
 * basis is absent (no fabricated 0% / $0).
 */
interface EfficiencySectionProps {
    efficiency: UsageEfficiencyViewModel;
}

export const EfficiencySection: React.FC<EfficiencySectionProps> = ({ efficiency }) => {
    const hasHitRate = efficiency.cacheHitRatePct !== null;
    const hasCostPerMtok = efficiency.costPerMtokUsd !== null;

    if (!hasHitRate && !hasCostPerMtok) {
        return null;
    }

    return (
        <View style={styles.row} testID="usage-efficiency-section">
            {hasHitRate && efficiency.cacheHitRatePct !== null ? (
                <View style={styles.cell} testID="usage-efficiency-cache-hit">
                    <TokenUsageRing
                        testID="usage-efficiency-cache-ring"
                        used={efficiency.cachedReadTokens}
                        limit={efficiency.inputTokens + efficiency.cachedReadTokens}
                        label={t('usage.efficiency.cacheHitRate')}
                        value={formatPercent(efficiency.cacheHitRatePct)}
                        tone="neutral"
                        size={48}
                        strokeWidth={3}
                    />
                    <View style={styles.cellText}>
                        <Text style={styles.label} numberOfLines={1}>{t('usage.efficiency.cacheHitRate')}</Text>
                        <Text style={styles.caption} numberOfLines={2}>{t('usage.efficiency.cacheHitCaption')}</Text>
                    </View>
                </View>
            ) : null}
            {hasCostPerMtok && efficiency.costPerMtokUsd !== null ? (
                <View style={styles.cell} testID="usage-efficiency-cost-per-mtok">
                    <View style={styles.cellText}>
                        <Text style={styles.statValue} numberOfLines={1}>
                            {formatUsageCost(efficiency.costPerMtokUsd, efficiency.currency)}
                        </Text>
                        <Text style={styles.label} numberOfLines={1}>{t('usage.efficiency.costPerMtok')}</Text>
                        <Text style={styles.caption} numberOfLines={2}>{t('usage.efficiency.costPerMtokCaption')}</Text>
                    </View>
                </View>
            ) : null}
        </View>
    );
};

const styles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 24,
        rowGap: 16,
        paddingVertical: 8,
    },
    cell: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minWidth: 140,
    },
    cellText: {
        gap: 2,
        flexShrink: 1,
    },
    statValue: {
        ...Typography.default('semiBold'),
        fontSize: 22,
        lineHeight: 26,
        letterSpacing: -0.3,
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
    label: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 16,
        letterSpacing: -0.05,
        color: theme.colors.text.secondary,
    },
    caption: {
        ...Typography.default(),
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.text.tertiary,
    },
}));
