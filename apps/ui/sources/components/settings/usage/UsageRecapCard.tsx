import * as React from 'react';
import { Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { t } from '@/text';
import { shadowLevelStyle } from '@/shadowElevation';

import type { UsageRecapCardAccentTone, UsageRecapCardModel } from './buildUsageRecapCardModels';
import { UsageActivitySquareMatrix, UsageProgressMeter, UsageSparkBars } from './UsageMiniVisuals';
import { UsageStatCard } from './UsageStatCard';

const styles = StyleSheet.create((theme) => ({
    actionButton: {
        width: 28,
        height: 28,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHigh,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
}));

function resolveAccentColor(accentTone: UsageRecapCardAccentTone, theme: ReturnType<typeof useUnistyles>['theme']): string {
    if (accentTone === 'blue') {
        return theme.colors.accent.blue;
    }
    if (accentTone === 'purple') {
        return theme.colors.accent.purple;
    }
    if (accentTone === 'green') {
        return theme.colors.accent.green;
    }
    return theme.colors.accent.orange;
}

export function UsageRecapCard(props: Readonly<{
    card: UsageRecapCardModel;
    onShare?: () => void;
}>): React.ReactElement {
    const { card, onShare } = props;
    const { theme } = useUnistyles();
    const accentColor = resolveAccentColor(card.accentTone, theme);

    const headerAccessory = typeof onShare === 'function'
        ? (
            <Pressable
                testID={card.shareTestID}
                accessibilityRole="button"
                accessibilityLabel={t('common.share')}
                style={styles.actionButton}
                onPress={onShare}
            >
                <SafeIonicons name="share-outline" size={14} color={theme.colors.textSecondary} />
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
            <UsageSparkBars
                activity={card.visual.activity}
                color={accentColor}
            />
        );
    }

    return (
        <UsageStatCard
            testID={card.testID}
            variant="inset"
            label={card.label}
            value={card.value}
            subtitle={card.subtitle}
            valueTone={card.valueTone}
            visual={visual}
            accentColor={accentColor}
            headerAccessory={headerAccessory}
        />
    );
}
