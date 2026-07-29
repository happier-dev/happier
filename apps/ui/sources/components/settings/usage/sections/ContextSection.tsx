import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { ContextGauge } from '@/components/instrument';
import { formatPercent, formatTokenCount } from '@/utils/format/usageNumbers';
import type { UsageContextViewModel } from '@/sync/api/account/usageAnalytics';
import { TokenMixDonut } from './TokenMixDonut';

interface ContextSectionProps {
    context: UsageContextViewModel;
}

/**
 * Section 7 — context & efficiency (session drilldown only; F-UI-3/F-SRV-3
 * closure). Latest context utilisation as the kit gauge + the period's token
 * mix as a static donut. Renders nothing without either signal.
 */

const styles = StyleSheet.create((theme) => ({
    body: {
        gap: 16,
    },
    utilizationRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
    },
    utilizationText: {
        gap: 2,
        flexShrink: 1,
    },
    label: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 16,
        letterSpacing: -0.05,
        color: theme.colors.text.secondary,
    },
    value: {
        ...Typography.default('semiBold'),
        fontSize: 20,
        lineHeight: 24,
        letterSpacing: -0.3,
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
    subtitle: {
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    donutBlock: {
        gap: 12,
    },
}));

export const ContextSection: React.FC<ContextSectionProps> = ({ context }) => {
    const hasUtilization = context.usedPct !== null;
    const hasMix = context.tokenMix.input > 0 || context.tokenMix.output > 0
        || context.tokenMix.reasoning > 0 || context.tokenMix.cacheRead > 0
        || context.tokenMix.cacheWrite > 0;

    if (!hasUtilization && !hasMix) {
        return null;
    }

    return (
        <View style={styles.body} testID="usage-context-section">
            {hasUtilization && context.usedPct !== null ? (
                <View style={styles.utilizationRow} testID="usage-context-utilization">
                    <ContextGauge usedPct={context.usedPct} size={28} />
                    <View style={styles.utilizationText}>
                        <Text style={styles.label}>{t('usage.context.utilization')}</Text>
                        <Text style={styles.value}>{formatPercent(context.usedPct)}</Text>
                        <Text style={styles.subtitle} numberOfLines={1}>
                            {`${formatTokenCount(context.usedTokens ?? 0)} / ${formatTokenCount(context.windowTokens ?? 0)} · ${t('usage.context.window')}`}
                        </Text>
                    </View>
                </View>
            ) : null}
            {hasMix ? (
                <View style={styles.donutBlock}>
                    <Text style={styles.label}>{t('usage.context.tokenMixTitle')}</Text>
                    <TokenMixDonut mix={context.tokenMix} testID="usage-context-token-mix" />
                </View>
            ) : null}
        </View>
    );
};
