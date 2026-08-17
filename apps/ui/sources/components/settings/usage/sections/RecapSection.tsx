import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { UsageAnalyticsViewModel, UsageCostMode, UsageFilterState, UsagePivotDimension } from '@/sync/api/account/usageAnalytics';
import { UsageActionChip } from '../UsageActionChip';
import { UsageExportActions } from '../UsageExportActions';
import { buildUsageRecapCardModels } from '../buildUsageRecapCardModels';
import { RecapStorySurface } from './recapStory/RecapStorySurface';

interface RecapSectionProps {
    viewModel: UsageAnalyticsViewModel;
    filters: UsageFilterState;
    displayCostMode: UsageCostMode;
    sessionId?: string;
    /** The active Band-5 pivot dimension, forwarded to the export actions (E-5). */
    pivotDimension?: UsagePivotDimension;
}

const styles = StyleSheet.create((theme) => ({
    root: {
        gap: 12,
    },
    actionsRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
    },
    caption: {
        ...Typography.default(),
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.text.tertiary,
    },
}));

/**
 * Band 7 — footer (D-R2-2). The recap CARDS deck was removed from the page
 * surface (its ALL-CAPS eyebrows / streak-tokens-model repetition now live ONLY
 * inside story mode). The footer keeps just the "Play recap" story-mode entry,
 * the export/share actions row, and an "Updated just now" caption.
 */
export const RecapSection: React.FC<RecapSectionProps> = ({
    viewModel,
    filters,
    displayCostMode,
    sessionId,
    pivotDimension,
}) => {
    const resolvedFilters = React.useMemo(
        () => ({ ...filters, costMode: displayCostMode }),
        [displayCostMode, filters],
    );

    // Live-QA finding: with a zero-token account the recap models are empty and
    // the story surface would open as a blank dialog — hide the entry instead.
    const hasRecapCards = React.useMemo(
        () => buildUsageRecapCardModels({ viewModel, filters: resolvedFilters }).length > 0,
        [resolvedFilters, viewModel],
    );

    const playRecap = React.useCallback(() => {
        let modalId: string | null = null;
        const close = () => {
            if (modalId) {
                Modal.hide(modalId);
                modalId = null;
            }
        };
        modalId = Modal.show({
            component: RecapStorySurface,
            onRequestClose: close,
            props: {
                viewModel,
                filters: resolvedFilters,
                cacheSavings: viewModel.cacheSavings,
                sessionId,
                onDismiss: close,
            },
        });
    }, [resolvedFilters, sessionId, viewModel]);

    return (
        <View style={styles.root} testID="usage-footer-section">
            <View style={styles.actionsRow}>
                {hasRecapCards ? (
                    <UsageActionChip
                        testID="usage-recap-play"
                        label={t('usage.recap.play')}
                        iconName="play"
                        onPress={playRecap}
                    />
                ) : null}
                <UsageExportActions
                    viewModel={viewModel}
                    filters={resolvedFilters}
                    sessionId={sessionId}
                    pivotDimension={pivotDimension}
                />
            </View>
            <Text style={styles.caption}>{t('usage.updatedCaption')}</Text>
        </View>
    );
};
