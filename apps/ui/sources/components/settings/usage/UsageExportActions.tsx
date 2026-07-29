import * as React from 'react';
import { View } from 'react-native';

import { t } from '@/text';

import { UsageActionChip } from './UsageActionChip';
import { buildUsageAnalyticsSummaryText, exportUsageAnalyticsJson, exportUsagePivotCsv, shareUsageAnalyticsSummary } from './usageAnalyticsExport';
import type { UsageAnalyticsViewModel, UsageFilterState, UsagePivotDimension } from '@/sync/api/account/usageAnalytics';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { Modal } from '@/modal';

type UsageExportActionsProps = Readonly<{
    viewModel: UsageAnalyticsViewModel;
    filters: UsageFilterState;
    sessionId?: string;
    /** The active Band-5 pivot dimension whose table the CSV/JSON export carries (E-5). */
    pivotDimension?: UsagePivotDimension;
}>;

export function UsageExportActions(props: UsageExportActionsProps): React.ReactElement {
    const { viewModel, filters, sessionId, pivotDimension } = props;
    const copyFeedback = useTemporaryCopyFeedback();
    const input = React.useMemo(() => ({
        viewModel,
        filters,
        sessionId: sessionId ?? null,
        pivotDimension,
    }), [viewModel, filters, sessionId, pivotDimension]);

    return (
        <View testID="usage-export-actions" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <UsageActionChip
                testID="usage-export-copy-summary"
                label={t('common.copyWithLabel', { label: t('usage.summary.title') })}
                iconName="copy-outline"
                accessory={<CopiedPill visible={copyFeedback.isCopied('summary')} testID="usage-export-copy-summary-feedback" />}
                onPress={() => {
                    void (async () => {
                        const copied = await setClipboardStringSafe(buildUsageAnalyticsSummaryText(input));
                        if (!copied) {
                            Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
                            return;
                        }
                        copyFeedback.markCopied('summary');
                    })();
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
                testID="usage-export-csv"
                label={t('usage.exportCsv')}
                iconName="grid-outline"
                onPress={() => {
                    void exportUsagePivotCsv(input);
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
