import React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type {
    UsageAnalyticsActivityViewModel,
    UsageHourRhythm,
    UsagePunchCard,
} from '@/sync/api/account/usageAnalytics';
import type { UsagePeriod } from '@/sync/api/account/usagePeriods';
import { UsageContributionHeatmap } from '../UsageContributionHeatmap';
import { HourRhythmChart } from '../charts/HourRhythmChart';
import { PunchCard } from '../charts/PunchCard';

/**
 * Period-adaptive heatmap window (D-R3-2): short periods render a compact
 * day-strip of exactly that many days (today = last cell), the year view keeps
 * the full 53-week contribution grid (`undefined` → the component's year grid).
 * The subtitle (owned by the Band header) always matches the rendered window.
 */
const HEATMAP_DAYS_BY_PERIOD: Record<UsagePeriod, number | undefined> = {
    today: 1,
    '7days': 7,
    '30days': 30,
    year: undefined,
};

/**
 * Band 3 "When you work" body (chromeless — the Band header owns the single
 * title + period subtitle). Round 2 (D-R2-1) replaced the debug chip grids with
 * a period-adaptive heatmap; E-2 upgrades the rhythm to the 7×24 PunchCard
 * (weekday×hour dot matrix), which subsumes the weekday bars. The 24-hour
 * HourRhythmChart survives only as the compact variant below the punch card's
 * width floor (<480px), where a 24-column grid would be unreadable.
 */
interface ActivitySectionProps {
    activity: UsageAnalyticsActivityViewModel;
    hourRhythm: UsageHourRhythm;
    punchCard: UsagePunchCard;
    period: UsagePeriod;
}

/** Below this width the 7×24 punch card is too dense; fall back to the 1-D hour rhythm. */
const PUNCH_CARD_MIN_WIDTH = 480;

const styles = StyleSheet.create((theme) => ({
    body: {
        gap: 20,
    },
    rhythmBlock: {
        gap: 8,
    },
    blockLabel: {
        ...Typography.default('semiBold'),
        fontSize: 11,
        lineHeight: 14,
        letterSpacing: -0.04,
        color: theme.colors.text.secondary,
    },
}));

export const ActivitySection: React.FC<ActivitySectionProps> = ({ activity, hourRhythm, punchCard, period }) => {
    const { width } = useWindowDimensions();
    const compact = width > 0 && width < PUNCH_CARD_MIN_WIDTH;
    const heatmapDays = HEATMAP_DAYS_BY_PERIOD[period];

    if (activity.calendarDays.length === 0 && activity.weekdayHourBuckets.length === 0) {
        return null;
    }

    const hasRhythm = punchCard.total > 0 || hourRhythm.total > 0;

    return (
        <View style={styles.body} testID="usage-activity-section">
            {activity.calendarDays.length > 0 ? (
                <UsageContributionHeatmap
                    testID="usage-activity-heatmap"
                    calendarDays={activity.calendarDays}
                    mode="daily"
                    days={heatmapDays}
                />
            ) : null}
            {hasRhythm ? (
                <View style={styles.rhythmBlock} testID="usage-activity-rhythm">
                    <Text style={styles.blockLabel}>{t('usage.workRhythm')}</Text>
                    {compact ? (
                        <HourRhythmChart rhythm={hourRhythm} testID="usage-rhythm-chart" />
                    ) : (
                        <PunchCard punchCard={punchCard} testID="usage-punchcard" />
                    )}
                </View>
            ) : null}
        </View>
    );
};
