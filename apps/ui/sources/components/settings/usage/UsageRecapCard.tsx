import * as React from 'react';
import { Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { MetricCard } from '@/components/ui/cards/MetricCard';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { t } from '@/text';
import { shadowLevelStyle } from '@/shadowElevation';

import type { UsageRecapCardModel } from './buildUsageRecapCardModels';
import { usageSignatureAccent } from './usageAccent';
import { formatIdentifierLabel } from './sections/shared';
import { UsageActivitySquareMatrix, UsageProgressMeter, UsageRankBars } from './UsageMiniVisuals';

const styles = StyleSheet.create((theme) => ({
    actionButton: {
        width: 28,
        height: 28,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.inset,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
}));

export function UsageRecapCard(props: Readonly<{
    card: UsageRecapCardModel;
    onShare?: () => void;
}>): React.ReactElement {
    const { card, onShare } = props;
    const { theme } = useUnistyles();
    // ONE-accent system (D-1): every recap meter uses the signature accent.
    const accentColor = usageSignatureAccent(theme);

    const headerAccessory = typeof onShare === 'function'
        ? (
            <Pressable
                testID={card.shareTestID}
                accessibilityRole="button"
                accessibilityLabel={t('common.share')}
                style={styles.actionButton}
                onPress={onShare}
            >
                <SafeIonicons name="share-outline" size={14} color={theme.colors.text.secondary} />
            </Pressable>
        )
        : null;

    let visual: React.ReactNode = null;
    if (card.visual.kind === 'activityMatrix') {
        visual = (
            <UsageActivitySquareMatrix
                activity={card.visual.activity}
                squareCount={card.visual.squareCount}
                rowSize={card.visual.rowSize}
                color={accentColor}
            />
        );
    } else if (card.visual.kind === 'progress') {
        visual = (
            <UsageProgressMeter
                ratio={card.visual.ratio}
                color={accentColor}
            />
        );
    } else {
        visual = (
            <UsageRankBars
                rows={card.visual.rows}
                color={accentColor}
            />
        );
    }

    return (
        <MetricCard
            testID={card.testID}
            label={card.label}
            value={formatIdentifierLabel(card.value)}
            subtitle={card.subtitle}
            valueTone={card.valueTone}
            visual={visual}
            headerAccessory={headerAccessory}
        />
    );
}
