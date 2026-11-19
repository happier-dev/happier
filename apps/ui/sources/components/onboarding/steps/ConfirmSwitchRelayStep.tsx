import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';

export type RelaySwitchDecision = 'keep' | 'switch';

const CHOICES = [
    { id: 'keep', icon: 'minus-circle', titleKey: 'setupOnboarding.confirmSwitchRelayKeepTitle', subtitleKey: 'setupOnboarding.confirmSwitchRelayKeepSubtitle' },
    { id: 'switch', icon: 'arrows-left-right', titleKey: 'setupOnboarding.confirmSwitchRelaySwitchTitle', subtitleKey: 'setupOnboarding.confirmSwitchRelaySwitchSubtitle' },
] as const satisfies readonly Readonly<{ id: RelaySwitchDecision; icon: string; titleKey: string; subtitleKey: string }>[];

const stylesheet = StyleSheet.create((theme) => ({
    selectedRelayCard: {
        width: '100%',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 14,
        paddingVertical: theme.space.s12,
        gap: theme.space.s6,
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
            <SelectionTiles<RelaySwitchDecision>
                testIdPrefix={`${props.testIDPrefix}-confirmSwitchRelay.choice`}
                accessibilityLabel={t('setupOnboarding.selectedRelayFooterLabel')}
                // Two columns in the welcome column, one where a card would be narrower than its sentence.
                maximumColumns={2}
                minimumTileWidth={240}
                options={CHOICES.map((choice) => ({ id: choice.id, icon: choice.icon, title: t(choice.titleKey), subtitle: t(choice.subtitleKey) }))}
                value={props.decision}
                onChange={(next) => { if (next) props.onDecisionChange(next); }}
            />
            <Text style={styles.confirmWarning}>{t('setupOnboarding.confirmSwitchRelayWarning')}</Text>
        </>
    );
});
