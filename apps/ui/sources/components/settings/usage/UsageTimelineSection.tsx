import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { CardGrid, CardGridColumn } from '@/components/ui/cards/CardGrid';
import { CardSection } from '@/components/ui/cards/CardSection';
import { PanelCard } from '@/components/ui/cards/PanelCard';
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
        <PanelCard
            testID={props.testID}
            headerEyebrow={props.label}
            title={leader}
        >
            <View style={styles.card}>
                <UsageJourneyChart timeline={props.timeline} />
            </View>
        </PanelCard>
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
        <CardSection
            title={t('usage.timeline')}
            subtitle={t('usage.activityCalendarSubtitle')}
            testID="usage-timeline-section"
        >
            <CardGrid
                columns={2}
                collapseBelow="medium"
                columnGap={12}
                rowGap={12}
            >
                {modelTimeline.length > 0 ? (
                    <CardGridColumn style={styles.column}>
                        <TimelineJourneyCard
                            testID="usage-model-timeline-card"
                            label={t('usage.summary.topModel')}
                            timeline={modelTimeline}
                        />
                    </CardGridColumn>
                ) : null}
                {engineTimeline.length > 0 ? (
                    <CardGridColumn style={styles.column}>
                        <TimelineJourneyCard
                            testID="usage-engine-timeline-card"
                            label={t('usage.summary.engine')}
                            timeline={engineTimeline}
                        />
                    </CardGridColumn>
                ) : null}
            </CardGrid>
        </CardSection>
    );
}
