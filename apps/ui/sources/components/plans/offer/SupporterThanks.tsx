import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { SupporterPass, type SupporterPassIdentity } from '../pass/SupporterPass';

/**
 * The Supporter thank-you (plan 04 U4): the pass, which turns over to the number when it arrives,
 * and the ring switch. The caller owns where the ring is stored, so the sheet writes the account
 * and the Developer preview only flips a local value.
 */
export function SupporterThanks(props: Readonly<{
    /** Null shows the blank pass until the number arrives; the pass turns over on arrival. */
    identity: SupporterPassIdentity | null;
    ring: boolean;
    onRingChange: (visible: boolean) => void;
    error: string | null;
    onDone: () => void;
}>) {
    return (
        <View style={styles.body} testID="supporter-thanks">
            <View style={styles.passRow}>
                <SupporterPass editionLabel={t('planSurface.passSupporterEdition')} identity={props.identity} width={200} />
            </View>
            <ItemGroup>
                <Item
                    title={t('planSurface.ringTitle')}
                    subtitle={t('planSurface.thanksRingHint')}
                    subtitleLines={0}
                    showChevron={false}
                    rightElement={<Switch value={props.ring} accessibilityLabel={t('planSurface.ringTitle')} onValueChange={props.onRingChange} />}
                />
            </ItemGroup>
            {props.error ? <Text style={styles.error} testID="supporter-offer-error">{props.error}</Text> : null}
            <RoundButton title={t('planSurface.done')} size="normal" onPress={props.onDone} testID="supporter-thanks-done" />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    body: {
        gap: 16,
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
    passRow: {
        alignItems: 'center',
        paddingVertical: 8,
    },
    error: {
        ...Typography.default(),
        fontSize: 13,
        color: theme.colors.state.danger.foreground,
    },
}));
