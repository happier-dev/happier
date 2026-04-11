import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemGroupColumn, ItemGroupColumns } from '@/components/ui/lists/ItemGroupColumns';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { UsageAnalyticsViewModel } from '@/sync/api/account/usageAnalytics';

import { UsageJourneyChart } from './UsageJourneyChart';

const styles = StyleSheet.create((theme) => ({
    sectionBody: {
        paddingBottom: 16,
        gap: 18,
    },
    note: {
        paddingHorizontal: 16,
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    column: {
        minWidth: 0,
    },
    card: {
        gap: 12,
    },
    cardHeader: {
        paddingHorizontal: 4,
        gap: 4,
    },
    cardLabel: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.groupped.sectionTitle,
        letterSpacing: -0.08,
    },
    cardValue: {
        ...Typography.default('semiBold'),
        fontSize: 34,
        lineHeight: 38,
        color: theme.colors.text,
        letterSpacing: -0.5,
    },
}));

function TimelineJourneyCard(props: Readonly<{
    testID: string;
    label: string;
    timeline: UsageAnalyticsViewModel['modelTimeline'];
}>): React.ReactElement {
    const leader = props.timeline[props.timeline.length - 1]?.leaders[0]?.label ?? t('usage.noData');

    return (
        <View testID={props.testID} style={styles.card}>
            <View style={styles.cardHeader}>
                <Text style={styles.cardLabel}>{props.label}</Text>
                <Text numberOfLines={1} adjustsFontSizeToFit style={styles.cardValue}>
                    {leader}
                </Text>
            </View>
            <UsageJourneyChart timeline={props.timeline} />
        </View>
    );
}

export function UsageTimelineSection(props: Readonly<{
    viewModel: Pick<UsageAnalyticsViewModel, 'modelTimeline' | 'engineTimeline'>;
}>): React.ReactElement | null {
    const { modelTimeline, engineTimeline } = props.viewModel;

    if (modelTimeline.length === 0 && engineTimeline.length === 0) {
        return null;
    }

    return (
        <View testID="usage-timeline-section">
            <ItemGroup title={t('usage.timeline')}>
                <View style={styles.sectionBody}>
                    <Text style={styles.note}>{t('usage.activityCalendarSubtitle')}</Text>
                    <ItemGroupColumns
                        columns={2}
                        collapseBelow="medium"
                        paddingHorizontal={16}
                        paddingVertical={0}
                        columnGap={12}
                        rowGap={12}
                    >
                        {modelTimeline.length > 0 ? (
                            <ItemGroupColumn style={styles.column}>
                                <TimelineJourneyCard
                                    testID="usage-model-timeline-card"
                                    label={t('usage.summary.topModel')}
                                    timeline={modelTimeline}
                                />
                            </ItemGroupColumn>
                        ) : null}
                        {engineTimeline.length > 0 ? (
                            <ItemGroupColumn style={styles.column}>
                                <TimelineJourneyCard
                                    testID="usage-engine-timeline-card"
                                    label={t('usage.summary.engine')}
                                    timeline={engineTimeline}
                                />
                            </ItemGroupColumn>
                        ) : null}
                    </ItemGroupColumns>
                </View>
            </ItemGroup>
        </View>
    );
}
