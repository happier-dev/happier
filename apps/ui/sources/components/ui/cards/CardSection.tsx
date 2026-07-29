import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

type CardSectionProps = Readonly<{
    title?: string;
    subtitle?: string;
    testID?: string;
    headerAccessory?: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    children: React.ReactNode;
}>;

const styles = StyleSheet.create((theme) => ({
    section: {
        gap: 12,
        paddingHorizontal: 16,
        paddingBottom: 16,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
    },
    headerTextBlock: {
        flex: 1,
        gap: 2,
        minWidth: 0,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        lineHeight: 20,
        letterSpacing: -0.2,
        color: theme.colors.text.primary,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
}));

export function CardSection(props: CardSectionProps): React.ReactElement {
    const {
        title,
        subtitle,
        testID,
        headerAccessory,
        style,
        children,
    } = props;

    return (
        <View testID={testID} style={[styles.section, style]}>
            {title || subtitle || headerAccessory ? (
                <View style={styles.header}>
                    <View style={styles.headerTextBlock}>
                        {title ? <Text style={styles.title}>{title}</Text> : null}
                        {subtitle ? (
                            <Text style={styles.subtitle}>{subtitle}</Text>
                        ) : null}
                    </View>
                    {headerAccessory}
                </View>
            ) : null}
            {children}
        </View>
    );
}
