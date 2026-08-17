import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { WizardChoiceRow } from '../ui/WizardChoiceRow';

export type RelaySwitchDecision = 'keep' | 'switch';

const stylesheet = StyleSheet.create((theme) => ({
    confirmChoices: {
        width: '100%',
        gap: 6,
    },
    selectedRelayCard: {
        width: '100%',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 14,
        paddingVertical: 12,
        gap: 6,
    },
    selectedRelayLabel: {
        color: theme.colors.text.secondary,
        textAlign: 'left',
    },
    selectedRelayUrl: {
        color: theme.colors.text.primary,
        textAlign: 'left',
    },
    confirmWarning: {
        color: theme.colors.text.secondary,
        textAlign: 'left',
    },
}));

export const ConfirmSwitchRelayStep = React.memo(function ConfirmSwitchRelayStep(props: Readonly<{
    testIDPrefix: string;
    relayUrl: string;
    decision: RelaySwitchDecision;
    onDecisionChange: (decision: RelaySwitchDecision) => void;
}>) {
    useUnistyles();
    const styles = stylesheet;
    const relayUrl = String(props.relayUrl ?? '').trim();

    return (
        <>
            <View testID={`${props.testIDPrefix}-confirmSwitchRelay`} style={styles.selectedRelayCard}>
                <Text style={styles.selectedRelayLabel}>{t('setupOnboarding.selectedRelayFooterLabel')}</Text>
                <Text style={styles.selectedRelayUrl} numberOfLines={1} ellipsizeMode="middle">
                    {relayUrl}
                </Text>
            </View>
            <View style={styles.confirmChoices}>
                <WizardChoiceRow
                    testID={`${props.testIDPrefix}-confirmSwitchRelay.choice:keep`}
                    selected={props.decision === 'keep'}
                    onPress={() => props.onDecisionChange('keep')}
                    icon="minus-circle"
                    title={t('setupOnboarding.confirmSwitchRelayKeepTitle')}
                    subtitle={t('setupOnboarding.confirmSwitchRelayKeepSubtitle')}
                />
                <WizardChoiceRow
                    testID={`${props.testIDPrefix}-confirmSwitchRelay.choice:switch`}
                    selected={props.decision === 'switch'}
                    onPress={() => props.onDecisionChange('switch')}
                    icon="arrows-left-right"
                    title={t('setupOnboarding.confirmSwitchRelaySwitchTitle')}
                    subtitle={t('setupOnboarding.confirmSwitchRelaySwitchSubtitle')}
                />
            </View>
            <Text style={styles.confirmWarning}>{t('setupOnboarding.confirmSwitchRelayWarning')}</Text>
        </>
    );
});
