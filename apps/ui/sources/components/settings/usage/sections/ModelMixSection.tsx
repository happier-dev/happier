import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import type { UsageModelMix } from '@/sync/api/account/usageAnalytics';
import { ModelMixAreaChart } from '../charts/ModelMixAreaChart';

/**
 * Band "Model mix over time" (B-1). One stacked-share area chart with a
 * Models⇄Engines lens toggle. The section owns only the lens state; both mixes
 * are pre-derived in the view model. Falls back to the twin lens when the active
 * one has no drawable data, and renders a calm empty state when neither does.
 */
type ModelMixLens = 'models' | 'engines';

type ModelMixSectionProps = Readonly<{
    modelMix: UsageModelMix;
    engineMix: UsageModelMix;
}>;

export const ModelMixSection: React.FC<ModelMixSectionProps> = ({ modelMix, engineMix }) => {
    const [lens, setLens] = React.useState<ModelMixLens>('models');

    const lensTabs = React.useMemo(() => ([
        { id: 'models' as const, label: t('settingsAgents.models') },
        { id: 'engines' as const, label: t('usage.summary.engine') },
    ]), []);

    const activeMix = lens === 'models' ? modelMix : engineMix;
    const bothLensesHaveData = modelMix.hasData && engineMix.hasData;

    if (!activeMix.hasData) {
        // Fall back to the twin lens if only one carries a drawable series.
        const fallback = lens === 'models' ? engineMix : modelMix;
        if (!fallback.hasData) {
            return (
                <View style={styles.body} testID="usage-model-mix-section">
                    <Text style={styles.empty}>{t('usage.noData.title')}</Text>
                </View>
            );
        }
    }

    const mixToRender = activeMix.hasData ? activeMix : (lens === 'models' ? engineMix : modelMix);

    return (
        <View style={styles.body} testID="usage-model-mix-section">
            {bothLensesHaveData ? (
                <View style={styles.toggleWrap}>
                    <SegmentedTabBar
                        testIDPrefix="usage-model-mix-lens"
                        tabs={lensTabs}
                        activeTabId={lens}
                        onSelectTab={setLens}
                        compact
                        slidingThumb
                        segmentSizing="content"
                    />
                </View>
            ) : null}
            <ModelMixAreaChart mix={mixToRender} testID="usage-model-mix-chart" />
        </View>
    );
};

const styles = StyleSheet.create((theme) => ({
    body: {
        gap: 12,
    },
    toggleWrap: {
        alignSelf: 'flex-start',
    },
    empty: {
        ...Typography.default(),
        paddingVertical: 24,
        textAlign: 'center',
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
}));
