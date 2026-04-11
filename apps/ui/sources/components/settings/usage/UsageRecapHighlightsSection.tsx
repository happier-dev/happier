import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemGroupColumn, ItemGroupColumns } from '@/components/ui/lists/ItemGroupColumns';
import { t } from '@/text';
import type { UsageAnalyticsViewModel, UsageFilterState } from '@/sync/api/account/usageAnalytics';

import { buildUsageRecapCardModels } from './buildUsageRecapCardModels';
import { UsageRecapCard } from './UsageRecapCard';
import { shareUsageRecapCardSummary } from './usageAnalyticsExport';

const styles = StyleSheet.create(() => ({
    sectionBody: {
        paddingBottom: 16,
    },
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
        <ItemGroup title={t('usage.summary.title')} containerStyle={{ overflow: 'visible' }}>
            <View testID="usage-recap-section" style={styles.sectionBody}>
                <ItemGroupColumns
                    columns={4}
                    collapseBelow="medium"
                    paddingHorizontal={16}
                    paddingVertical={0}
                    columnGap={12}
                    rowGap={12}
                >
                    {recapCards.map((card) => (
                        <ItemGroupColumn key={card.id} style={styles.recapColumn}>
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
                        </ItemGroupColumn>
                    ))}
                </ItemGroupColumns>
            </View>
        </ItemGroup>
    );
}
