import React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { t } from '@/text';
import { USAGE_PERIODS, type UsagePeriod } from '@/sync/api/account/usagePeriods';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import type {
    UsageAnalyticsViewModel,
    UsageCostMode,
    UsageFilterState,
    UsageFocus,
    UsageMetric,
} from '@/sync/api/account/usageAnalytics';
import { UsageToggleChip } from '../UsageToggleChip';
import { resolveCostModeLabel } from './shared';
import { usageSignatureAccent } from '../usageAccent';

interface FiltersSectionProps {
    viewModel: UsageAnalyticsViewModel;
    filters: UsageFilterState;
    displayCostMode: UsageCostMode;
    focusLabel: string | null;
    sessionId?: string;
    isRefreshing: boolean;
    onPeriodChange: (period: UsageFilterState['period']) => void;
    onMetricChange: (metric: UsageMetric) => void;
    onCostModeChange: (mode: UsageCostMode) => void;
    onFocusChange: (focus: UsageFocus | null) => void;
}

const PERIOD_SHORT_LABEL: Record<UsagePeriod, 'usage.periodTodayShort' | 'usage.period7dShort' | 'usage.period30dShort' | 'usage.periodYearShort'> = {
    today: 'usage.periodTodayShort',
    '7days': 'usage.period7dShort',
    '30days': 'usage.period30dShort',
    year: 'usage.periodYearShort',
};

const styles = StyleSheet.create((theme) => ({
    // ONE continuous command bar (D-R2-5): a segmented period control + a ghost
    // cost-mode menu, on the page surface (no floating PanelCard).
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 8,
        minHeight: 44,
    },
    periodWrap: {
        flex: 1,
        minWidth: 0,
        maxWidth: 320,
    },
    trailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
    },
    focusRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        paddingHorizontal: 16,
        paddingBottom: 8,
    },
    refresh: {
        width: 24,
        height: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

export const FiltersSection: React.FC<FiltersSectionProps> = ({
    viewModel,
    filters,
    displayCostMode,
    focusLabel,
    isRefreshing,
    onPeriodChange,
    onCostModeChange,
    onFocusChange,
}) => {
    const { theme } = useUnistyles();
    const [costModeMenuOpen, setCostModeMenuOpen] = React.useState(false);

    const periodTabs = React.useMemo(
        () => USAGE_PERIODS.map((period) => ({ id: period, label: t(PERIOD_SHORT_LABEL[period]) })),
        [],
    );
    const costModeItems = React.useMemo(() => {
        const items = [{ id: 'auto', title: t('usage.auto') }];
        if (viewModel.availableCostModes.includes('reported')) {
            items.push({ id: 'reported', title: t('usage.reported') });
        }
        if (viewModel.availableCostModes.includes('estimated')) {
            items.push({ id: 'estimated', title: t('usage.estimated') });
        }
        return items;
    }, [viewModel.availableCostModes]);

    return (
        <View>
            <View style={styles.bar}>
                <View style={styles.periodWrap}>
                    <SegmentedTabBar
                        testIDPrefix="usage-filter-period"
                        tabs={periodTabs}
                        activeTabId={filters.period}
                        onSelectTab={(tabId) => onPeriodChange(tabId)}
                        compact
                        slidingThumb
                    />
                </View>
                <View style={styles.trailing}>
                    <DropdownMenu
                        open={costModeMenuOpen}
                        onOpenChange={setCostModeMenuOpen}
                        items={costModeItems}
                        selectedId={displayCostMode}
                        onSelect={(itemId) => onCostModeChange(itemId as UsageCostMode)}
                        itemTrigger={{
                            title: resolveCostModeLabel(displayCostMode),
                            showSelectedDetail: false,
                            showSelectedSubtitle: false,
                            itemProps: {
                                testID: 'usage-filter-cost-mode',
                                density: 'compact',
                            },
                        }}
                    />
                    {isRefreshing ? (
                        <View style={styles.refresh} testID="usage-refresh-overlay" pointerEvents="none">
                            <ActivitySpinner size="small" color={usageSignatureAccent(theme)} />
                        </View>
                    ) : null}
                </View>
            </View>
            {focusLabel ? (
                <View style={styles.focusRow}>
                    <UsageToggleChip
                        testID="usage-focus-clear"
                        label={focusLabel}
                        selected
                        accentColor={usageSignatureAccent(theme)}
                        onPress={() => onFocusChange(null)}
                    />
                </View>
            ) : null}
        </View>
    );
};
