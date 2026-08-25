import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { t } from '@/text';

export type ActiveRelaySummaryProps = Readonly<{
    relayUrl: string;
    status: 'active' | 'selected';
    idPrefix?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    copy: {
        flex: 1,
        minWidth: 0,
        gap: 1,
    },
    label: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 12,
        lineHeight: 16,
    },
    value: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 12,
        lineHeight: 16,
    },
}));

export function ActiveRelaySummary(props: ActiveRelaySummaryProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const label = props.status === 'active'
        ? t('setupOnboarding.activeRelaySummaryTitle')
        : t('setupOnboarding.selectedRelaySummaryTitle');

    return (
        <View testID={props.idPrefix} style={styles.container}>
            <Icon name={props.status === 'active' ? 'cloud-check' : 'cloud'} size={18} color={theme.colors.text.secondary} />
            <View style={styles.copy}>
                <Text testID={`${props.idPrefix ?? 'relay-summary'}-label`} style={styles.label}>{label}</Text>
                <Text
                    testID={`${props.idPrefix ?? 'relay-summary'}-line`}
                    style={styles.value}
                    numberOfLines={1}
                    ellipsizeMode="middle"
                >
                    {toServerUrlDisplay(props.relayUrl)}
                </Text>
            </View>
        </View>
    );
}
