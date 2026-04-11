import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { UsageAnalyticsTimelineBucket, UsageAnalyticsViewModel, UsageSummaryActivityPoint } from '@/sync/api/account/usageAnalytics';

import { UsageSparkBars } from './UsageMiniVisuals';
import { UsageStatCard } from './UsageStatCard';

const styles = StyleSheet.create((theme) => ({
    sectionBody: {
        gap: 12,
    },
    cardRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 12,
    },
    cardColumn: {
        flexGrow: 1,
        flexBasis: '48%',
        minWidth: 160,
    },
    sectionNote: {
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
}));

function buildTimelineVisualPoints(timeline: readonly UsageAnalyticsTimelineBucket[]): UsageSummaryActivityPoint[] {
    return timeline.map((bucket) => {
        const leader = bucket.leaders[0] ?? null;
        return {
            timestamp: Math.floor(bucket.bucketStartMs / 1000),
            active: Boolean(leader),
            tokens: leader?.totalTokens ?? 0,
            cost: leader?.totalCost ?? 0,
        };
    });
}

function buildTimelineSubtitle(timeline: readonly UsageAnalyticsTimelineBucket[]): string {
    if (timeline.length === 0) {
        return t('usage.noData');
    }
    const firstBucket = timeline[0];
    const lastBucket = timeline[timeline.length - 1];
    const topLeader = lastBucket?.leaders[0]?.label ?? t('usage.noData');
    const start = new Date(firstBucket.bucketStartMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const end = new Date(lastBucket.bucketEndMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${start} - ${end} · ${topLeader}`;
}

function buildTimelineValue(timeline: readonly UsageAnalyticsTimelineBucket[]): string {
    const lastBucket = [...timeline].sort((left, right) => right.bucketStartMs - left.bucketStartMs)[0];
    return lastBucket?.leaders[0]?.label ?? t('usage.noData');
}

function TimelineCard(props: Readonly<{
    testID: string;
    label: string;
    timeline: readonly UsageAnalyticsTimelineBucket[];
    accentColor: string;
}>): React.ReactElement {
    const visualPoints = buildTimelineVisualPoints(props.timeline);

    return (
        <UsageStatCard
            testID={props.testID}
            variant="surface"
            label={props.label}
            value={buildTimelineValue(props.timeline)}
            subtitle={buildTimelineSubtitle(props.timeline)}
            visual={<UsageSparkBars activity={visualPoints} color={props.accentColor} />}
        />
    );
}

export function UsageTimelineSection(props: Readonly<{
    viewModel: Pick<UsageAnalyticsViewModel, 'modelTimeline' | 'engineTimeline'>;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();

    if (props.viewModel.modelTimeline.length === 0 && props.viewModel.engineTimeline.length === 0) {
        return null;
    }

    return (
        <View testID="usage-timeline-section">
            <ItemGroup title={t('usage.timeline')}>
                <View style={styles.sectionBody}>
                    <Text style={styles.sectionNote}>{t('usage.activityCalendarSubtitle')}</Text>
                    <View style={styles.cardRow}>
                        {props.viewModel.modelTimeline.length > 0 ? (
                            <View style={styles.cardColumn}>
                                <TimelineCard
                                    testID="usage-model-timeline-card"
                                    label={t('usage.summary.topModel')}
                                    timeline={props.viewModel.modelTimeline}
                                    accentColor={theme.colors.accent.green}
                                />
                            </View>
                        ) : null}
                        {props.viewModel.engineTimeline.length > 0 ? (
                            <View style={styles.cardColumn}>
                                <TimelineCard
                                    testID="usage-engine-timeline-card"
                                    label={t('usage.summary.engine')}
                                    timeline={props.viewModel.engineTimeline}
                                    accentColor={theme.colors.accent.orange}
                                />
                            </View>
                        ) : null}
                    </View>
                </View>
            </ItemGroup>
        </View>
    );
}
