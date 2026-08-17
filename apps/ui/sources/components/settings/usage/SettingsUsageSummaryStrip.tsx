import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { UsageAnalyticsViewModel } from '@/sync/api/account/usageAnalytics';
import { INSTRUMENT_PRESS_SCALE, InstrumentCard } from '@/components/instrument';

import { buildUsageSettingsRouteTarget } from './usageRouteParams';
import { formatTokenCount } from '@/utils/format/usageNumbers';
import { formatCount } from './sections/shared';
import { UsageStatRow } from './UsageStatRow';
import { buildUsageBannerModel, type UsageBannerModel } from './buildUsageBannerModel';
import {
    UsageContributionHeatmap,
    type UsageHeatmapMode,
} from './UsageContributionHeatmap';

type SettingsUsageSummaryStripProps = Readonly<{
    viewModel: UsageAnalyticsViewModel | null;
    isLoading?: boolean;
    errorMessage?: string | null;
    onOpenUsage?: (target: ReturnType<typeof buildUsageSettingsRouteTarget>) => void;
}>;

/** Single horizontal inset shared by every band inside the banner card (D-R4-2). */
const BAND_PAD_H = 16;

const styles = StyleSheet.create((theme) => ({
    wrapper: {
        alignSelf: 'center',
        width: '100%',
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 12,
    },
    card: {
        paddingVertical: 4,
    },
    pressablePressed: {
        opacity: 0.9,
        transform: [{ scale: INSTRUMENT_PRESS_SCALE }],
    },
    statsRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
        // ONE horizontal padding for every band inside the card (D-R4-2): the
        // stats row, the heatmap block, and the insight lists all inset by
        // BAND_PAD_H so no band is flush while its neighbour is doubly inset.
        paddingHorizontal: BAND_PAD_H,
        paddingVertical: 20,
    },
    statCell: {
        flex: 1,
        // Fit the widest compact numeral (e.g. "983.4k") without ellipsizing
        // (F-CAP-3): a real min-width plus tighter padding keeps full tabular
        // figures visible instead of clipping to "983…" at narrow widths.
        minWidth: 58,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        paddingHorizontal: 4,
    },
    statDivider: {
        width: StyleSheet.hairlineWidth,
        alignSelf: 'stretch',
        marginVertical: 4,
        backgroundColor: theme.colors.border.default,
    },
    statValue: {
        ...Typography.default('semiBold'),
        fontSize: 19,
        lineHeight: 24,
        letterSpacing: -0.4,
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
        textAlign: 'center',
    },
    statLabel: {
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
    divider: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.border.default,
        marginHorizontal: BAND_PAD_H,
    },
    block: {
        paddingHorizontal: BAND_PAD_H,
        paddingVertical: 16,
        gap: 12,
    },
    blockHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    blockTitle: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        lineHeight: 20,
        letterSpacing: -0.2,
        color: theme.colors.text.primary,
    },
    toggleRow: {
        flexDirection: 'row',
        gap: 16,
    },
    toggleText: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    toggleTextActive: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    listsRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        paddingHorizontal: BAND_PAD_H,
        // Match the heatmap block's rhythm under the divider so the hairline
        // sits the same distance above "Activity insights"/"Most used" as it
        // does above "Token activity" (D-R4-2 / one band grid); the extra
        // bottom padding keeps the last rows off the card's bottom edge.
        paddingTop: 16,
        paddingBottom: 20,
        gap: 24,
    },
    listColumn: {
        // Equal column widths (D-R4-2): both share the row evenly from a zero
        // basis instead of a 220 basis that let content skew their widths.
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        minWidth: 160,
        gap: 4,
    },
    listTitle: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        lineHeight: 20,
        letterSpacing: -0.2,
        color: theme.colors.text.primary,
    },
    listRows: {
        gap: 0,
    },
    loadingBlock: {
        height: 16,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.inset,
    },
    emptyText: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
}));

const STREAK_UNIT = (count: number): string => t('usage.banner.days', { count });

const StatCell: React.FC<{ testID: string; label: string; value: string }> = ({ testID, label, value }) => (
    <View style={styles.statCell} testID={testID}>
        <Text style={styles.statValue} numberOfLines={1}>{value}</Text>
        <Text style={styles.statLabel} numberOfLines={2}>{label}</Text>
    </View>
);

function StatsRow({ model, onPress }: Readonly<{ model: UsageBannerModel; onPress?: () => void }>) {
    const cells = [
        { testID: 'usage-banner-stat-lifetime', label: t('usage.banner.lifetimeTokens'), value: formatTokenCount(model.lifetimeTokens) },
        { testID: 'usage-banner-stat-peak', label: t('usage.banner.peakTokens'), value: formatTokenCount(model.peakBucketTokens) },
        { testID: 'usage-banner-stat-sessions', label: t('settings.sessions'), value: formatCount(model.sessions) },
        { testID: 'usage-banner-stat-current-streak', label: t('usage.summary.currentStreak'), value: STREAK_UNIT(model.currentStreakDays) },
        { testID: 'usage-banner-stat-longest-streak', label: t('usage.longestStreak'), value: STREAK_UNIT(model.longestStreakDays) },
    ];
    const content = (
        <View style={styles.statsRow}>
            {cells.map((cell, index) => (
                <React.Fragment key={cell.testID}>
                    {index > 0 ? <View style={styles.statDivider} /> : null}
                    <StatCell testID={cell.testID} label={cell.label} value={cell.value} />
                </React.Fragment>
            ))}
        </View>
    );
    if (!onPress) return content;
    return (
        <Pressable
            testID="settings-usage-summary-open-stats"
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={t('settings.usage')}
            style={({ pressed }) => (pressed ? styles.pressablePressed : null)}
        >
            {content}
        </Pressable>
    );
}

const HEATMAP_MODES: readonly UsageHeatmapMode[] = ['daily', 'weekly', 'cumulative'] as const;

function HeatmapBlock({ viewModel }: Readonly<{ viewModel: UsageAnalyticsViewModel }>) {
    const [mode, setMode] = React.useState<UsageHeatmapMode>('daily');
    const modeLabel: Record<UsageHeatmapMode, string> = {
        daily: t('usage.banner.daily'),
        weekly: t('usage.banner.weekly'),
        cumulative: t('usage.banner.cumulative'),
    };
    return (
        <View style={styles.block}>
            <View style={styles.blockHeader}>
                <Text style={styles.blockTitle}>{t('usage.banner.tokenActivity')}</Text>
                <View style={styles.toggleRow}>
                    {HEATMAP_MODES.map((option) => (
                        <Pressable
                            key={option}
                            testID={`usage-banner-heatmap-mode-${option}`}
                            accessibilityRole="button"
                            accessibilityState={{ selected: option === mode }}
                            onPress={() => setMode(option)}
                        >
                            <Text style={[styles.toggleText, option === mode ? styles.toggleTextActive : null]}>
                                {modeLabel[option]}
                            </Text>
                        </Pressable>
                    ))}
                </View>
            </View>
            <UsageContributionHeatmap
                testID="usage-banner-heatmap"
                calendarDays={viewModel.activity.calendarDays}
                mode={mode}
            />
        </View>
    );
}

function ListsRow({ model, onPress }: Readonly<{ model: UsageBannerModel; onPress?: () => void }>) {
    // No "Total tokens" row here: it duplicates the Lifetime-tokens stat cell
    // (identical value) and, being a 4th row against the 3-row neighbour column,
    // orphaned below its baseline (D-R4-2). Three balanced rows per column.
    const insightRows = [
        { label: t('usage.busiestWindow'), value: model.busiestWindowLabel ?? t('usage.noData.title') },
        { label: t('usage.modelsTried'), value: formatCount(model.modelsTried) },
        { label: t('usage.activeDays'), value: formatCount(model.activeDays) },
    ];
    const mostUsedRows: Array<{ label: string; value: string }> = [];
    if (model.favoriteModelLabel) {
        mostUsedRows.push({ label: t('usage.summary.topModel'), value: model.favoriteModelLabel });
    }
    for (const row of model.mostUsed) {
        mostUsedRows.push({ label: row.label, value: `${formatCount(row.events)} ${t('usage.events')}` });
    }
    if (mostUsedRows.length === 0) {
        mostUsedRows.push({ label: t('usage.noData.title'), value: '—' });
    }

    const content = (
        <View style={styles.listsRow}>
            <View style={styles.listColumn} testID="usage-banner-activity-insights">
                <Text style={styles.listTitle}>{t('usage.banner.activityInsights')}</Text>
                <View style={styles.listRows}>
                    {insightRows.map((row) => (
                        <UsageStatRow key={row.label} label={row.label} value={row.value} />
                    ))}
                </View>
            </View>
            <View style={styles.listColumn} testID="usage-banner-most-used">
                <Text style={styles.listTitle}>{t('usage.banner.mostUsed')}</Text>
                <View style={styles.listRows}>
                    {mostUsedRows.map((row, index) => (
                        <UsageStatRow key={`${row.label}-${index}`} label={row.label} value={row.value} />
                    ))}
                </View>
            </View>
        </View>
    );
    if (!onPress) return content;
    return (
        <Pressable
            testID="settings-usage-summary-open-lists"
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={t('settings.usage')}
            style={({ pressed }) => (pressed ? styles.pressablePressed : null)}
        >
            {content}
        </Pressable>
    );
}

export const SettingsUsageSummaryStrip = React.memo(function SettingsUsageSummaryStrip(props: SettingsUsageSummaryStripProps) {
    const { viewModel, isLoading = false, errorMessage = null, onOpenUsage } = props;
    // Composed at render time: the module-scope stylesheet evaluates once, so a
    // baked-in `layout.maxWidth` would freeze the user's content-width preference.
    const wrapperMaxWidthStyle = useLayoutMaxWidthStyle();
    const model = React.useMemo(
        () => (viewModel ? buildUsageBannerModel(viewModel, Date.now()) : null),
        [viewModel],
    );

    if (!isLoading && !errorMessage && (model == null || model.hasData === false)) {
        return null;
    }

    const openUsage = onOpenUsage
        ? () => onOpenUsage(buildUsageSettingsRouteTarget({ period: 'year', metric: 'tokens' }))
        : undefined;

    return (
        <View style={[styles.wrapper, wrapperMaxWidthStyle]}>
            <View testID="settings-usage-summary-strip">
                <InstrumentCard>
                    <View style={styles.card}>
                        {isLoading && model == null ? (
                            <View style={{ padding: 20, gap: 12 }} testID="settings-usage-summary-loading">
                                <View style={[styles.loadingBlock, { width: '80%' }]} />
                                <View style={[styles.loadingBlock, { width: '55%' }]} />
                                <View style={[styles.loadingBlock, { width: '90%', height: 60 }]} />
                            </View>
                        ) : errorMessage ? (
                            <Text style={styles.emptyText}>{errorMessage}</Text>
                        ) : model && viewModel ? (
                            <View>
                                <StatsRow model={model} onPress={openUsage} />
                                <View style={styles.divider} />
                                <HeatmapBlock viewModel={viewModel} />
                                <View style={styles.divider} />
                                <ListsRow model={model} onPress={openUsage} />
                            </View>
                        ) : null}
                    </View>
                </InstrumentCard>
            </View>
        </View>
    );
});
