import * as React from 'react';
import { View } from 'react-native';

import { t } from '@/text';

import { UsageActionChip } from './UsageActionChip';
import { buildUsageAnalyticsSummaryText, exportUsageAnalyticsJson, shareUsageAnalyticsSummary } from './usageAnalyticsExport';
import type { UsageAnalyticsViewModel, UsageFilterState } from '@/sync/api/account/usageAnalytics';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

type UsageExportActionsProps = Readonly<{
    viewModel: UsageAnalyticsViewModel;
    filters: UsageFilterState;
    sessionId?: string;
}>;

export function UsageExportActions(props: UsageExportActionsProps): React.ReactElement {
    const { viewModel, filters, sessionId } = props;
    const input = React.useMemo(() => ({
        viewModel,
        filters,
        sessionId: sessionId ?? null,
    }), [viewModel, filters, sessionId]);

    return (
        <View testID="usage-export-actions" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <UsageActionChip
                testID="usage-export-copy-summary"
                label={t('common.copyWithLabel', { label: t('usage.summary.title') })}
                iconName="copy-outline"
                onPress={() => {
                    void setClipboardStringSafe(buildUsageAnalyticsSummaryText(input));
                }}
            />
            <UsageActionChip
                testID="usage-export-json"
                label={t('files.repositoryTree.actions.download')}
                iconName="download-outline"
                onPress={() => {
                    void exportUsageAnalyticsJson(input);
                }}
            />
            <UsageActionChip
                testID="usage-export-share-summary"
                label={t('common.share')}
                iconName="share-outline"
                onPress={() => {
                    void shareUsageAnalyticsSummary(input);
                }}
            />
        </View>
    );
}
