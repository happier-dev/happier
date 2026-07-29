import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { SurfaceCard } from './SurfaceCard';

type PanelCardProps = Readonly<{
    title?: string;
    subtitle?: string;
    headerEyebrow?: string;
    headerAccessory?: React.ReactNode;
    children: React.ReactNode;
    testID?: string;
    tone?: 'surface' | 'muted';
    padding?: 'none' | 'sm' | 'md' | 'lg';
    style?: StyleProp<ViewStyle>;
    bodyStyle?: StyleProp<ViewStyle>;
}>;

const styles = StyleSheet.create((theme) => ({
    card: {
        gap: 14,
        minWidth: 0,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        minWidth: 0,
    },
    headerText: {
        flex: 1,
        minWidth: 0,
        gap: 4,
    },
    eyebrow: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        lineHeight: 16,
        color: theme.colors.text.secondary,
        letterSpacing: -0.08,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 28,
        lineHeight: 34,
        letterSpacing: -0.6,
        color: theme.colors.text.primary,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
}));

export const PanelCard = React.memo(function PanelCard(props: PanelCardProps) {
    const {
        title,
        subtitle,
        headerEyebrow,
        headerAccessory,
        children,
        testID,
        tone = 'surface',
        padding = 'lg',
        style,
        bodyStyle,
    } = props;

    const hasHeader = Boolean(title || subtitle || headerEyebrow || headerAccessory);

    return (
        <SurfaceCard
            testID={testID}
            tone={tone}
            padding={padding}
            style={style}
        >
            <View style={styles.card}>
                {hasHeader ? (
                    <View style={styles.header}>
                        <View style={styles.headerText}>
                            {headerEyebrow ? <Text style={styles.eyebrow}>{headerEyebrow}</Text> : null}
                            {title ? (
                                <Text numberOfLines={2} adjustsFontSizeToFit style={styles.title}>
                                    {title}
                                </Text>
                            ) : null}
                            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
                        </View>
                        {headerAccessory}
                    </View>
                ) : null}
                <View style={bodyStyle}>{children}</View>
            </View>
        </SurfaceCard>
    );
});
