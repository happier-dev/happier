import React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { AnimatedNumber } from '@/components/instrument';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import type { UsageHeroTrend, UsageHeroViewModel } from '@/sync/api/account/usageAnalytics';
import { usageSignatureAccent, withUsageAccentAlpha } from '../usageAccent';
import { MiniSparkline } from '../charts/MiniSparkline';
import { formatCount } from './shared';

/**
 * Band 2 "How much" — the surface's first band body (chromeless; the Band owns
 * padding, header and the entrance). An oversized token odometer with an inline
 * period sparkline and a period-over-period delta pill, over a hairline-divided
 * stat row (cost · sessions · events · longest streak). Numbers all flow through
 * the ONE formatter and render tabular.
 */
interface HeroSectionProps {
    hero: UsageHeroViewModel;
    heroTrend?: UsageHeroTrend;
}

function formatDeltaPct(deltaPct: number): string {
    const rounded = Math.round(Math.abs(deltaPct));
    return `${rounded}%`;
}

const StatCell: React.FC<{ label: string; value: string; caption?: string; testID?: string; captionAccent?: boolean }>
    = ({ label, value, caption, testID, captionAccent }) => {
        const { theme } = useUnistyles();
        return (
            <View style={styles.statCell} testID={testID}>
                <Text style={styles.statLabel} numberOfLines={1}>{label}</Text>
                <Text style={styles.statValue} numberOfLines={1}>{value}</Text>
                {caption ? (
                    <Text
                        style={[styles.statCaption, captionAccent ? { color: usageSignatureAccent(theme) } : null]}
                        numberOfLines={1}
                    >
                        {caption}
                    </Text>
                ) : null}
            </View>
        );
    };

export const HeroSection: React.FC<HeroSectionProps> = ({ hero, heroTrend }) => {
    const { theme } = useUnistyles();
    const accent = usageSignatureAccent(theme);
    const delta = heroTrend?.delta;
    const sparkline = heroTrend?.sparkline ?? [];
    const showDelta = delta && delta.deltaPct !== null && delta.direction !== 'flat';
    const up = delta?.direction === 'up';

    return (
        <View style={styles.body} testID="usage-hero-card">
            <View style={styles.heroRow}>
                <AnimatedNumber
                    testID="usage-hero-total"
                    value={hero.totalTokens}
                    format={formatTokenCount}
                    emphasisPulse
                    textStyle={styles.heroNumber}
                />
                <Text style={styles.heroUnit}>{t('usage.tokens')}</Text>
                {sparkline.length > 1 ? (
                    <View style={styles.sparkline}>
                        <MiniSparkline
                            testID="usage-hero-sparkline"
                            values={sparkline}
                            width={44}
                            height={16}
                            color={accent}
                            strokeWidth={1.75}
                        />
                    </View>
                ) : null}
                {showDelta ? (
                    <View
                        testID="usage-hero-delta"
                        accessibilityLabel={`${formatDeltaPct(delta!.deltaPct!)} ${t('usage.vsPreviousPeriod')}`}
                        style={[
                            styles.deltaPill,
                            {
                                backgroundColor: up
                                    ? withUsageAccentAlpha(accent, 0.14)
                                    : theme.colors.surface.base,
                            },
                        ]}
                    >
                        <Text style={[styles.deltaText, { color: up ? accent : theme.colors.text.secondary }]}>
                            {`${up ? '▲' : '▼'} ${formatDeltaPct(delta!.deltaPct!)}`}
                        </Text>
                    </View>
                ) : null}
            </View>

            <View style={[styles.accentMark, { backgroundColor: accent }]} testID="usage-hero-accent-mark" />

            <View style={styles.statRow}>
                <StatCell
                    testID="usage-hero-stat-cost"
                    label={t('usage.cost')}
                    value={formatUsageCost(hero.effectiveUsd, hero.currency)}
                />
                <StatCell
                    testID="usage-hero-stat-sessions"
                    label={t('settings.sessions')}
                    value={formatCount(hero.sessions)}
                />
                <StatCell
                    testID="usage-hero-stat-events"
                    label={t('usage.eventsLabel')}
                    value={formatCount(hero.events)}
                    caption={hero.messages > 0 ? t('usage.messagesCaption', { count: hero.messages }) : undefined}
                />
                <StatCell
                    testID="usage-hero-stat-streak"
                    label={t('usage.longestStreak')}
                    value={t('usage.daysShort', { count: hero.longestStreakDays })}
                />
            </View>
        </View>
    );
};

const styles = StyleSheet.create((theme) => ({
    body: {
        gap: 16,
    },
    heroRow: {
        flexDirection: 'row',
        alignItems: 'baseline',
        flexWrap: 'wrap',
        gap: 8,
    },
    heroNumber: {
        ...Typography.default('semiBold'),
        fontSize: 32,
        lineHeight: 38,
        letterSpacing: -1,
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
    heroUnit: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        lineHeight: 20,
        letterSpacing: -0.1,
        color: theme.colors.text.secondary,
    },
    sparkline: {
        alignSelf: 'center',
        marginLeft: 2,
    },
    deltaPill: {
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 2,
        alignSelf: 'center',
    },
    deltaText: {
        ...Typography.default('semiBold'),
        fontSize: 11,
        lineHeight: 14,
        fontVariant: ['tabular-nums'],
    },
    accentMark: {
        width: 44,
        height: 4,
        borderRadius: 2,
    },
    statRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 20,
        rowGap: 14,
    },
    statCell: {
        gap: 2,
        minWidth: 68,
    },
    statLabel: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 16,
        letterSpacing: -0.05,
        color: theme.colors.text.secondary,
    },
    statValue: {
        ...Typography.default('semiBold'),
        fontSize: 22,
        lineHeight: 26,
        letterSpacing: -0.3,
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
    statCaption: {
        ...Typography.default(),
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.text.tertiary,
    },
}));
