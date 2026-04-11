import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { SurfaceCard } from './SurfaceCard';

export type MetricCardValueTone = 'numeric' | 'compact';
export type MetricCardSize = 'default' | 'hero';

type MetricCardProps = Readonly<{
    label: string;
    value: string;
    subtitle?: string;
    visual?: React.ReactNode;
    headerAccessory?: React.ReactNode;
    testID?: string;
    onPress?: () => void;
    valueTone?: MetricCardValueTone;
    size?: MetricCardSize;
    tone?: 'surface' | 'muted';
    style?: StyleProp<ViewStyle>;
    contentStyle?: StyleProp<ViewStyle>;
}>;

const styles = StyleSheet.create((theme) => ({
    content: {
        minWidth: 0,
        gap: 8,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
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
    labelHero: {
        fontSize: 12,
        lineHeight: 16,
        letterSpacing: 0.16,
    },
    valueNumeric: {
        ...Typography.default('semiBold'),
        fontSize: 40,
        lineHeight: 44,
        letterSpacing: -0.7,
        color: theme.colors.text,
    },
    valueNumericHero: {
        fontSize: 58,
        lineHeight: 62,
        letterSpacing: -1.2,
    },
    valueCompact: {
        ...Typography.default('semiBold'),
        fontSize: 28,
        lineHeight: 34,
        letterSpacing: -0.45,
        color: theme.colors.text,
    },
    valueCompactHero: {
        fontSize: 42,
        lineHeight: 46,
        letterSpacing: -0.72,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.textSecondary,
    },
    subtitleHero: {
        fontSize: 16,
        lineHeight: 22,
    },
    footer: {
        marginTop: 4,
        gap: 10,
    },
}));

export const MetricCard = React.memo(function MetricCard(props: MetricCardProps) {
    const {
        label,
        value,
        subtitle,
        visual,
        headerAccessory,
        testID,
        onPress,
        valueTone = 'numeric',
        size = 'default',
        tone = 'surface',
        style,
        contentStyle,
    } = props;

    const valueStyle = React.useMemo(() => {
        if (valueTone === 'compact') {
            return [styles.valueCompact, size === 'hero' ? styles.valueCompactHero : null];
        }
        return [styles.valueNumeric, size === 'hero' ? styles.valueNumericHero : null];
    }, [size, valueTone]);

    return (
        <SurfaceCard
            testID={testID}
            onPress={onPress}
            tone={tone}
            style={style}
        >
            <View style={[styles.content, contentStyle]}>
                <View style={styles.header}>
                    <Text style={[styles.label, size === 'hero' ? styles.labelHero : null]}>{label}</Text>
                    {headerAccessory}
                </View>
                <Text
                    numberOfLines={valueTone === 'compact' ? 2 : 1}
                    ellipsizeMode="tail"
                    adjustsFontSizeToFit
                    minimumFontScale={0.72}
                    style={valueStyle}
                >
                    {value}
                </Text>
                {subtitle ? (
                    <Text
                        numberOfLines={3}
                        ellipsizeMode="tail"
                        style={[styles.subtitle, size === 'hero' ? styles.subtitleHero : null]}
                    >
                        {subtitle}
                    </Text>
                ) : null}
                {visual ? <View style={styles.footer}>{visual}</View> : null}
            </View>
        </SurfaceCard>
    );
});
