import React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { CardSection, PanelCard } from '@/components/ui/cards';
import { t } from '@/text';
import type {
    UsageAnalyticsViewModel,
    UsageBreakdownRow,
    UsageFocus,
    UsageMetric,
} from '@/sync/api/account/usageAnalytics';
import { usageMeterFill } from '../usageAccent';
import { UsageBar } from '../UsageBar';

interface BreakdownsSectionProps {
    breakdowns: UsageAnalyticsViewModel['breakdowns'];
    metric: UsageMetric;
    focus: UsageFocus | null;
    onFocusChange: (focus: UsageFocus | null) => void;
    resolveDisplayLabel: (dimension: UsageBreakdownRow['dimension'], label: string, key: string) => string;
}

function renderBreakdownSection(
    title: string,
    rows: UsageBreakdownRow[],
    metric: UsageMetric,
    focus: UsageFocus | null,
    onFocusChange: (focus: UsageFocus | null) => void,
    resolveMeterFill: (emphasized: boolean) => string,
    resolveDisplayLabel: (dimension: UsageBreakdownRow['dimension'], label: string, key: string) => string,
): React.ReactElement | null {
    if (rows.length === 0) {
        return null;
    }

    const rowValue = (row: UsageBreakdownRow) => (metric === 'tokens' ? row.totalTokens : row.totalCost);
    const maxValue = Math.max(...rows.map(rowValue), 1);
    const visibleRows = rows.slice(0, 5);
    // ONE-accent system (D-1): accent marks the ACTUAL leader or the current
    // selection; every other row is monochrome (rows may not be pre-sorted).
    const leaderIndex = visibleRows.reduce(
        (best, row, index) => (rowValue(row) > rowValue(visibleRows[best]!) ? index : best),
        0,
    );

    return (
        <CardSection title={title}>
            <PanelCard padding="md">
                <View style={{ gap: 12 }}>
                    {visibleRows.map((row, index) => {
                        const selected = focus?.dimension === row.dimension && focus.key === row.key;
                        const displayLabel = resolveDisplayLabel(row.dimension, row.label, row.key);
                        return (
                            <UsageBar
                                key={`${row.dimension}:${row.key}`}
                                testID={`usage-breakdown-row-${row.dimension}-${row.key}`}
                                label={displayLabel}
                                value={rowValue(row)}
                                maxValue={maxValue}
                                color={resolveMeterFill(selected || index === leaderIndex)}
                                active={selected}
                                showPercentage={false}
                                onPress={(row.dimension === 'bucket' || row.dimension === 'week') ? undefined : () => {
                                    if (row.dimension === 'bucket' || row.dimension === 'week') {
                                        return;
                                    }
                                    onFocusChange({
                                        dimension: row.dimension,
                                        key: row.key,
                                        label: displayLabel,
                                    });
                                }}
                            />
                        );
                    })}
                </View>
            </PanelCard>
        </CardSection>
    );
}

export const BreakdownsSection: React.FC<BreakdownsSectionProps> = ({
    breakdowns,
    metric,
    focus,
    onFocusChange,
    resolveDisplayLabel,
}) => {
    const { theme } = useUnistyles();
    const resolveMeterFill = React.useCallback(
        (emphasized: boolean) => usageMeterFill(theme, emphasized),
        [theme],
    );
    return (
        <>
            {renderBreakdownSection(t('settingsAgents.title'), breakdowns.agents, metric, focus, onFocusChange, resolveMeterFill, resolveDisplayLabel)}
            {renderBreakdownSection(t('settingsAgents.models'), breakdowns.models, metric, focus, onFocusChange, resolveMeterFill, resolveDisplayLabel)}
            {renderBreakdownSection(t('settings.sessions'), breakdowns.sessions, metric, focus, onFocusChange, resolveMeterFill, resolveDisplayLabel)}
            {renderBreakdownSection(t('tabs.projects'), breakdowns.projects, metric, focus, onFocusChange, resolveMeterFill, resolveDisplayLabel)}
            {renderBreakdownSection(t('settings.workspaces'), breakdowns.workspaces, metric, focus, onFocusChange, resolveMeterFill, resolveDisplayLabel)}
            {renderBreakdownSection(t('usage.summary.engine'), breakdowns.backendModes, metric, focus, onFocusChange, resolveMeterFill, resolveDisplayLabel)}
        </>
    );
};
