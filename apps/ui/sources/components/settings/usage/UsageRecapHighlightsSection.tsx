import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { CardGrid, CardGridColumn } from '@/components/ui/cards';
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

    const recapCards = React.useMemo(() => buildUsageRecapCardModels({
        viewModel,
        filters,
    }), [viewModel, filters]);

    if (recapCards.length === 0) {
        return null;
    }

    return (
        <View testID="usage-recap-section">
            <CardGrid columns={4} columnGap={12} rowGap={12}>
                {recapCards.map((card) => (
                    <CardGridColumn key={card.id} style={styles.recapColumn}>
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
