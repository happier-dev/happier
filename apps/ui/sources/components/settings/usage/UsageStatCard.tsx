import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

type UsageStatCardVariant = 'inset' | 'surface';
type UsageStatCardValueTone = 'numeric' | 'compact';

type UsageStatCardProps = Readonly<{
    label: string;
    value: string;
    subtitle?: string;
    visual?: React.ReactNode;
    headerAccessory?: React.ReactNode;
    testID?: string;
    onPress?: () => void;
    variant?: UsageStatCardVariant;
    valueTone?: UsageStatCardValueTone;
    accentColor?: string | null;
}>;

const styles = StyleSheet.create((theme) => ({
    card: {
        borderRadius: 18,
        padding: 16,
        gap: 10,
        minWidth: 0,
    },
    surfaceCard: {
        backgroundColor: theme.colors.surface,
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 6 },
        elevation: 2,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    insetCard: {
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    label: {
        flex: 1,
        fontSize: 12,
        fontWeight: '700',
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
    },
    valueNumeric: {
        fontSize: 28,
        lineHeight: 32,
        fontWeight: '800',
        color: theme.colors.text,
    },
    valueCompact: {
        fontSize: 21,
        lineHeight: 26,
        fontWeight: '700',
        color: theme.colors.text,
    },
    subtitle: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    footer: {
        gap: 8,
        marginTop: 2,
    },
    accentLine: {
        height: 3,
        borderRadius: 999,
        backgroundColor: theme.colors.divider,
        marginTop: 2,
    },
    pressable: {
        borderRadius: 18,
    },
}));

export const UsageStatCard = React.memo(function UsageStatCard(props: UsageStatCardProps) {
    const {
        label,
        value,
        subtitle,
        visual,
        headerAccessory,
        testID,
        onPress,
        variant = 'surface',
        valueTone = 'numeric',
        accentColor,
    } = props;

    const content = (
        <View
            testID={testID}
            style={[
                styles.card,
                variant === 'surface' ? styles.surfaceCard : styles.insetCard,
            ]}
        >
            <View style={styles.header}>
                <Text style={styles.label}>{label}</Text>
                {headerAccessory}
            </View>
            <Text
                numberOfLines={valueTone === 'compact' ? 2 : 1}
                ellipsizeMode="tail"
                style={valueTone === 'compact' ? styles.valueCompact : styles.valueNumeric}
            >
                {value}
            </Text>
            {subtitle ? (
                <Text numberOfLines={2} ellipsizeMode="tail" style={styles.subtitle}>
                    {subtitle}
                </Text>
            ) : null}
            {visual ? <View style={styles.footer}>{visual}</View> : null}
            {accentColor ? <View style={[styles.accentLine, { backgroundColor: accentColor }]} /> : null}
        </View>
    );

    if (typeof onPress !== 'function') {
        return content;
    }

    return (
        <Pressable style={styles.pressable} onPress={onPress}>
            {content}
        </Pressable>
    );
});
