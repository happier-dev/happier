import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { CardGrid, CardGridColumn } from '@/components/ui/cards/CardGrid';
import type { UsageAnalyticsViewModel, UsageFilterState } from '@/sync/api/account/usageAnalytics';

import { buildUsageRecapCardModels } from './buildUsageRecapCardModels';
import { UsageRecapCard } from './UsageRecapCard';
import { shareUsageRecapCardSummary } from './usageAnalyticsExport';

const styles = StyleSheet.create(() => ({
    recapColumn: {
        minWidth: 170,
    },
}));

export function UsageRecapHighlightsSection(props: Readonly<{
    viewModel: UsageAnalyticsViewModel;
    filters: UsageFilterState;
    sessionId?: string;
}>): React.ReactElement | null {
    const { viewModel, filters, sessionId } = props;
    const { width } = useWindowDimensions();

    const recapCards = React.useMemo(() => buildUsageRecapCardModels({
        viewModel,
        filters,
    }), [viewModel, filters]);

    if (recapCards.length === 0) {
        return null;
    }

    const columns = width >= 1180 ? 4 : width >= 720 ? 2 : 1;

    return (
        <View testID="usage-recap-section">
            <CardGrid
                columns={columns as 1 | 2 | 3 | 4}
                collapseBelow="medium"
                columnGap={12}
                rowGap={12}
                style={{ overflow: 'visible' }}
            >
                {recapCards.map((card) => (
                    <CardGridColumn
                        key={card.id}
                        span={card.id === 'streak' && columns >= 4 ? 2 : 1}
                        style={styles.recapColumn}
                    >
                        <UsageRecapCard
                            card={card}
                            onShare={() => {
                                void shareUsageRecapCardSummary({
                                    viewModel,
                                    filters,
                                    sessionId,
                                    cardId: card.id,
                                });
                            }}
                        />
                    </CardGridColumn>
                ))}
            </CardGrid>
        </View>
    );
}
