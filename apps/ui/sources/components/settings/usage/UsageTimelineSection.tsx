import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { CardSection, PanelCard } from '@/components/ui/cards';
import { t } from '@/text';
import type { UsageAnalyticsViewModel, UsageMetric } from '@/sync/api/account/usageAnalytics';

import { UsageJourneyChart } from './UsageJourneyChart';
import { formatIdentifierLabel } from './sections/shared';

const styles = StyleSheet.create(() => ({
    stack: {
        gap: 12,
    },
}));

function TimelineJourneyCard(props: Readonly<{
    testID: string;
    label: string;
    timeline: UsageAnalyticsViewModel['modelTimeline'];
    metric: UsageMetric;
    currency: string;
}>): React.ReactElement {
    const leaderRaw = props.timeline[props.timeline.length - 1]?.leaders[0]?.label ?? t('usage.noData.title');
    const leader = formatIdentifierLabel(leaderRaw);

    return (
        <PanelCard
            testID={props.testID}
            headerEyebrow={props.label}
            subtitle={leader}
        >
            <UsageJourneyChart timeline={props.timeline} metric={props.metric} currency={props.currency} />
        </PanelCard>
    );
}

export function UsageTimelineSection(props: Readonly<{
    viewModel: Pick<UsageAnalyticsViewModel, 'modelTimeline' | 'engineTimeline' | 'costPresentation'>;
    metric: UsageMetric;
}>): React.ReactElement | null {
    const { modelTimeline, engineTimeline } = props.viewModel;
    const { metric } = props;
    const currency = props.viewModel.costPresentation.currency || 'USD';

    if (modelTimeline.length === 0 && engineTimeline.length === 0) {
        return null;
    }

    return (
        <CardSection
            title={t('usage.timeline')}
            subtitle={t('usage.activityCalendarSubtitle')}
            testID="usage-timeline-section"
        >
            <View style={styles.stack}>
                {modelTimeline.length > 0 ? (
                    <TimelineJourneyCard
                        testID="usage-model-timeline-card"
                        label={t('usage.summary.topModel')}
                        timeline={modelTimeline}
                        metric={metric}
                        currency={currency}
                    />
                ) : null}
                {engineTimeline.length > 0 ? (
                    <TimelineJourneyCard
                        testID="usage-engine-timeline-card"
                        label={t('usage.summary.engine')}
                        timeline={engineTimeline}
                        metric={metric}
                        currency={currency}
                    />
                ) : null}
            </View>
        </CardSection>
    );
}
