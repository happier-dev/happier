import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { MiddleEllipsisText } from '@/components/ui/text/MiddleEllipsisText';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveHomeDisplayNameForRelayUrl } from '@/components/settings/server/homeDisplayName';
import { t } from '@/text';

export type ActiveRelaySummaryProps = Readonly<{
    relayUrl: string;
    status: 'active' | 'selected';
    idPrefix?: string;
    /**
     * `summary` (default) is the labelled capsule under a step card's actions. `line` is one quiet
     * line naming the Home above a step's heading, where the step's column is the context.
     */
    presentation?: 'summary' | 'line';
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s8,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    copy: {
        flex: 1,
        minWidth: 0,
        gap: 1,
    },
    label: {
        color: theme.colors.text.primary,
        ...Typography.variant('meta', 'semiBold'),
    },
    value: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta'),
    },
    line: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        minWidth: 0,
        maxWidth: '100%',
    },
    lineValue: {
        flexShrink: 1,
        minWidth: 0,
        color: theme.colors.text.secondary,
        ...Typography.variant('meta', 'semiBold'),
    },
}));

/**
 * The one quiet line naming the Home a signed-out step acts on, above the step's heading. Callers
 * pass the Home's label from the Home label owner (`homeDisplayName`).
 */
export function HomeContextLine({ label, address, accessibilityLabel, testID, lineTestID }: Readonly<{
    accessibilityLabel?: string;
    testID?: string;
    lineTestID?: string;
}> & (Readonly<{ label: string; address?: never }> | Readonly<{ label?: string; address: string }>)) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    return (
        <View
            testID={testID}
            style={styles.line}
            accessible
            accessibilityLabel={accessibilityLabel ?? (label && address ? `${label} · ${address}` : address ?? label)}
        >
            <Icon name="house" size={14} color={theme.colors.text.secondary} />
            {label ? <Text testID={address ? undefined : lineTestID} numberOfLines={1} style={styles.lineValue}>
                {address ? `${label} ·` : label}
            </Text> : null}
            {address ? <MiddleEllipsisText testID={lineTestID} value={address} style={styles.lineValue} /> : null}
        </View>
    );
}

export function ActiveRelaySummary(props: ActiveRelaySummaryProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const label = props.status === 'active'
        ? t('setupOnboarding.activeRelaySummaryTitle')
        : t('setupOnboarding.selectedRelaySummaryTitle');

    const homeName = resolveHomeDisplayNameForRelayUrl(props.relayUrl) ?? t('settingsAccount.thisHomeTitle');

    if (props.presentation === 'line') {
        return (
            <HomeContextLine
                testID={props.idPrefix}
                lineTestID={`${props.idPrefix ?? 'relay-summary'}-line`}
                label={homeName}
                accessibilityLabel={`${label}: ${homeName}`}
            />
        );
    }

    return (
        <View testID={props.idPrefix} style={styles.container}>
            <Icon name={props.status === 'active' ? 'cloud-check' : 'cloud'} size={18} color={theme.colors.text.secondary} />
            <View style={styles.copy}>
                <Text testID={`${props.idPrefix ?? 'relay-summary'}-label`} style={styles.label}>{label}</Text>
                <Text
                    testID={`${props.idPrefix ?? 'relay-summary'}-line`}
                    style={styles.value}
                >
                    {homeName}
                </Text>
            </View>
        </View>
    );
}
