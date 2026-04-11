import * as React from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { shadowLevelStyle } from '@/shadowElevation';

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
    contentStyle?: StyleProp<ViewStyle>;
}>;

const styles = StyleSheet.create((theme) => ({
    card: {
        borderRadius: 16,
        paddingHorizontal: 18,
        paddingVertical: 16,
        gap: 8,
        minWidth: 0,
    },
    surfaceCard: {
        backgroundColor: theme.colors.surface,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    insetCard: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    label: {
        flex: 1,
        ...Typography.default('semiBold'),
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.groupped.sectionTitle,
        letterSpacing: 0.24,
        textTransform: 'uppercase',
    },
    valueNumeric: {
        ...Typography.default('semiBold'),
        fontSize: 40,
        lineHeight: 44,
        letterSpacing: -0.7,
        color: theme.colors.text,
    },
    valueCompact: {
        ...Typography.default('semiBold'),
        fontSize: 28,
        lineHeight: 33,
        letterSpacing: -0.4,
        color: theme.colors.text,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    footer: {
        gap: 10,
        marginTop: 4,
    },
    pressable: {
        borderRadius: 16,
        overflow: 'hidden',
    },
    pressablePressed: {
        opacity: 0.985,
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
        contentStyle,
    } = props;

    const content = (
        <View
            testID={testID}
            style={[
                styles.card,
                variant === 'surface' ? styles.surfaceCard : styles.insetCard,
                contentStyle,
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
        </View>
    );

    if (typeof onPress !== 'function') {
        return content;
    }

    return (
        <Pressable style={({ pressed }) => [styles.pressable, pressed && styles.pressablePressed]} onPress={onPress}>
            {content}
        </Pressable>
    );
});
