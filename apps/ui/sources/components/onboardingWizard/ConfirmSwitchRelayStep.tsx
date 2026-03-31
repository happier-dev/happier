import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export type RelaySwitchDecision = 'keep' | 'switch';

const stylesheet = StyleSheet.create((theme) => ({
    confirmChoices: {
        width: '100%',
        gap: 6,
    },
    confirmWarning: {
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
}));

export const ConfirmSwitchRelayStep = React.memo(function ConfirmSwitchRelayStep(props: Readonly<{
    testIDPrefix: string;
    relayUrl: string;
    decision: RelaySwitchDecision;
    onDecisionChange: (decision: RelaySwitchDecision) => void;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const relayUrl = String(props.relayUrl ?? '').trim();

    return (
        <>
            <ItemGroup
                title={t('setupOnboarding.confirmSwitchRelayTitle')}
                footer={t('setupOnboarding.confirmSwitchRelaySubtitle')}
            >
                <Item
                    testID={`${props.testIDPrefix}-confirmSwitchRelay`}
                    title={t('setupOnboarding.selectedRelayFooterLabel')}
                    subtitle={relayUrl}
                    showChevron={false}
                    mode="info"
                />
            </ItemGroup>
            <View style={styles.confirmChoices}>
                <SelectableRow
                    testID={`${props.testIDPrefix}-confirmSwitchRelay.choice:keep`}
                    variant="selectable"
                    selected={props.decision === 'keep'}
                    onPress={() => props.onDecisionChange('keep')}
                    left={(
                        <Ionicons
                            name="remove-circle-outline"
                            size={18}
                            color={props.decision === 'keep' ? theme.colors.accent.blue : theme.colors.textSecondary}
                        />
                    )}
                    title={t('setupOnboarding.confirmSwitchRelayKeepTitle')}
                    subtitle={t('setupOnboarding.confirmSwitchRelayKeepSubtitle')}
                    right={(
                        <Ionicons
                            name={props.decision === 'keep' ? 'checkmark-circle' : 'ellipse-outline'}
                            size={18}
                            color={props.decision === 'keep' ? theme.colors.accent.blue : theme.colors.textSecondary}
                        />
                    )}
                />
                <SelectableRow
                    testID={`${props.testIDPrefix}-confirmSwitchRelay.choice:switch`}
                    variant="selectable"
                    selected={props.decision === 'switch'}
                    onPress={() => props.onDecisionChange('switch')}
                    left={(
                        <Ionicons
                            name="swap-horizontal-outline"
                            size={18}
                            color={props.decision === 'switch' ? theme.colors.accent.blue : theme.colors.textSecondary}
                        />
                    )}
                    title={t('setupOnboarding.confirmSwitchRelaySwitchTitle')}
                    subtitle={t('setupOnboarding.confirmSwitchRelaySwitchSubtitle')}
                    right={(
                        <Ionicons
                            name={props.decision === 'switch' ? 'checkmark-circle' : 'ellipse-outline'}
                            size={18}
                            color={props.decision === 'switch' ? theme.colors.accent.blue : theme.colors.textSecondary}
                        />
                    )}
                />
            </View>
            <Text style={styles.confirmWarning}>{t('setupOnboarding.confirmSwitchRelayWarning')}</Text>
        </>
    );
});

