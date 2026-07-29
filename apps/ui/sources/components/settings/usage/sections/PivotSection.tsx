import React from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import {
    USAGE_PIVOT_DIMENSIONS,
    buildUsagePivotView,
    type UsageBreakdownRow,
    type UsageBreakdownSections,
    type UsageFocus,
    type UsageLeaderTrends,
    type UsagePivotDimension,
} from '@/sync/api/account/usageAnalytics';
import { usageMeterFill, usageSignatureAccent, withUsageAccentAlpha } from '../usageAccent';
import { MiniSparkline } from '../charts/MiniSparkline';
import { USAGE_ROW_MIN_HEIGHT, USAGE_ROW_PAD_V } from '../UsageStatRow';
import { dimensionLabel, formatCount, formatIdentifierLabel } from './shared';

/**
 * Band 5 "What" dimension pivot (E-1, replaces the Leaders block). ONE segmented
 * control drives the existing ranked-row shape across
 * Models · Agents · Sessions · Projects · Workspaces · Sources. Sessions resolve
 * their local title (never a raw id) and deep-link to the session usage route;
 * Projects/Workspaces (and Models/Agents/Sources) apply the page focus filter on
 * press. Per-row sparklines appear only where a timeline exists (models/agents).
 * The Sessions lens gains table-density cost/events columns at wide widths (E-4).
 */
type PivotSectionProps = Readonly<{
    breakdowns: UsageBreakdownSections;
    leaderTrends: UsageLeaderTrends;
    dimension: UsagePivotDimension;
    /** Currency for the Sessions-lens cost column (from the presented cost mode). */
    currency: string;
    onDimensionChange: (dimension: UsagePivotDimension) => void;
    resolveDisplayLabel: (dimension: UsageBreakdownRow['dimension'], label: string, key: string) => string;
    onFocusChange?: (focus: UsageFocus | null) => void;
    onOpenSession?: (sessionId: string) => void;
}>;

const TOP_ROWS = 8;
/** At/above this width the Sessions lens shows tokens · cost · events columns (E-4). */
const TABLE_DENSITY_MIN_WIDTH = 560;

export const PivotSection: React.FC<PivotSectionProps> = ({
    breakdowns,
    leaderTrends,
    dimension,
    currency,
    onDimensionChange,
    resolveDisplayLabel,
    onFocusChange,
    onOpenSession,
}) => {
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const accent = usageSignatureAccent(theme);
    const [expanded, setExpanded] = React.useState(false);

    const view = React.useMemo(
        () => buildUsagePivotView(breakdowns, leaderTrends, dimension),
        [breakdowns, leaderTrends, dimension],
    );

    // Reset the expansion when the dimension changes so a new lens starts collapsed.
    React.useEffect(() => {
        setExpanded(false);
    }, [dimension]);

    const tabs = React.useMemo(
        () => USAGE_PIVOT_DIMENSIONS.map((dim) => ({ id: dim, label: dimensionLabel(dim) })),
        [],
    );

    const visibleRows = expanded ? view.rows : view.rows.slice(0, TOP_ROWS);
    const hasMore = view.rows.length > TOP_ROWS;
    const isSessions = dimension === 'session';
    const showColumns = isSessions && width >= TABLE_DENSITY_MIN_WIDTH;
    const showSpark = view.hasTrend;

    return (
        <View style={styles.body} testID="usage-pivot-section">
            <SegmentedTabBar
                testIDPrefix="usage-pivot-dimension"
                tabs={tabs}
                activeTabId={dimension}
                onSelectTab={onDimensionChange}
                compact
                slidingThumb
            />
            <View style={styles.rows}>
                {visibleRows.map((entry, index) => {
                    const { row, sharePct, trend, isLeader } = entry;
                    const label = resolveDisplayLabel(dimension, row.label, row.key);
                    const press = () => {
                        if (isSessions) {
                            onOpenSession?.(row.key);
                            return;
                        }
                        // Weeks are a chronological ledger, not a focus dimension —
                        // no page filter to apply, so the row is non-interactive.
                        if (dimension === 'week') {
                            return;
                        }
                        onFocusChange?.({ dimension, key: row.key, label });
                    };
                    const interactive = dimension === 'week'
                        ? false
                        : isSessions ? Boolean(onOpenSession) : Boolean(onFocusChange);
                    return (
                        <Pressable
                            key={row.key}
                            style={({ pressed }) => [styles.row, pressed && interactive ? styles.rowPressed : null]}
                            testID={`usage-pivot-row-${dimension}-${row.key}`}
                            accessibilityRole={interactive ? 'button' : 'text'}
                            accessibilityLabel={`${formatIdentifierLabel(label)} · ${formatTokenCount(row.totalTokens)}`}
                            onPress={interactive ? press : undefined}
                        >
                            <Text style={styles.rank}>{index + 1}</Text>
                            <Text style={styles.name} numberOfLines={1}>{formatIdentifierLabel(label)}</Text>
                            {showSpark && trend.length > 1 ? (
                                <View style={styles.spark}>
                                    <MiniSparkline
                                        values={trend}
                                        width={48}
                                        height={12}
                                        color={usageMeterFill(theme, isLeader)}
                                        strokeWidth={1.5}
                                    />
                                </View>
                            ) : null}
                            <Text style={styles.tokens} numberOfLines={1}>{formatTokenCount(row.totalTokens)}</Text>
                            {showColumns ? (
                                <>
                                    <Text style={styles.metric} numberOfLines={1}>
                                        {formatUsageCost(row.totalCost, currency)}
                                    </Text>
                                    <Text style={styles.metric} numberOfLines={1}>
                                        {formatCount(row.reportCount)}
                                    </Text>
                                </>
                            ) : null}
                            <View
                                style={[
                                    styles.pill,
                                    { backgroundColor: isLeader ? withUsageAccentAlpha(accent, 0.14) : theme.colors.surface.base },
                                ]}
                            >
                                <Text style={[styles.pillText, { color: isLeader ? accent : theme.colors.text.secondary }]}>
                                    {`${Math.round(sharePct)}%`}
                                </Text>
                            </View>
                        </Pressable>
                    );
                })}
            </View>
            {hasMore ? (
                <Pressable
                    testID="usage-pivot-show-all"
                    accessibilityRole="button"
                    onPress={() => setExpanded((current) => !current)}
                    style={({ pressed }) => [styles.showAll, pressed ? styles.rowPressed : null]}
                >
                    <Text style={[styles.showAllText, { color: accent }]}>
                        {expanded ? t('usage.showLess') : t('usage.showAll')}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
};

const styles = StyleSheet.create((theme) => ({
    body: {
        gap: 12,
    },
    rows: {
        // Rows own their vertical rhythm via the shared compact-row density
        // (Task 2: one standard for banner + page rows), so no extra gap here.
        gap: 0,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: USAGE_ROW_PAD_V,
        minHeight: USAGE_ROW_MIN_HEIGHT,
    },
    rowPressed: {
        opacity: 0.6,
    },
    rank: {
        ...Typography.default(),
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.text.tertiary,
        width: 14,
        fontVariant: ['tabular-nums'],
    },
    name: {
        ...Typography.default(),
        flex: 1,
        fontSize: 13,
        lineHeight: 16,
        color: theme.colors.text.primary,
    },
    spark: {
        width: 48,
    },
    tokens: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 16,
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
        textAlign: 'right',
        minWidth: 48,
    },
    metric: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 16,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
        textAlign: 'right',
        minWidth: 56,
    },
    pill: {
        borderRadius: 4,
        paddingHorizontal: 5,
        paddingVertical: 1,
        minWidth: 34,
        alignItems: 'center',
    },
    pillText: {
        ...Typography.default('semiBold'),
        fontSize: 11,
        lineHeight: 14,
        fontVariant: ['tabular-nums'],
    },
    showAll: {
        paddingVertical: 4,
        alignSelf: 'flex-start',
    },
    showAllText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        lineHeight: 16,
    },
}));
