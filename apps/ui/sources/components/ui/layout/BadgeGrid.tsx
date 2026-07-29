import * as React from 'react';
import { View, ViewStyle, StyleProp } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

export interface BadgeGridItem {
    id: string;
    label: string;
    status: 'positive' | 'negative' | 'neutral' | 'warning';
    detail?: string;
}

export interface BadgeGridProps {
    items: ReadonlyArray<BadgeGridItem>;
    columns?: 2 | 3;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}

const STATUS_ICON: Record<BadgeGridItem['status'], React.ComponentProps<typeof SafeIonicons>['name']> = {
    positive: 'checkmark-circle',
    negative: 'close-circle',
    neutral: 'ellipse',
    warning: 'warning',
};

export const BadgeGrid = React.memo<BadgeGridProps>(({ items, columns = 3, testID, style }) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    // Approximate minWidth so badges wrap at the right column count
    const minWidth = columns === 2 ? '45%' : '28%';

    return (
        <View testID={testID} style={[styles.container, style]}>
            {items.map((item) => {
                // Status glyph tints come from theme state tokens so every theme
                // profile (incl. dark) keeps contrast (audit PLG-1).
                const statusColors: Record<BadgeGridItem['status'], string> = {
                    positive: theme.colors.state.success.foreground,
                    negative: theme.colors.state.danger.foreground,
                    neutral: theme.colors.state.neutral.foreground,
                    warning: theme.colors.state.warning.foreground,
                };
                return (
                    <View key={item.id} style={[styles.badge, { minWidth }]}>
                        <View
                            style={styles.icon}
                            accessibilityElementsHidden
                            importantForAccessibility="no"
                        >
                            <SafeIonicons
                                name={STATUS_ICON[item.status]}
                                size={16}
                                color={statusColors[item.status]}
                            />
                        </View>
                        <View style={styles.badgeText}>
                            <Text
                                style={[styles.label, { color: theme.colors.text.primary }]}
                                numberOfLines={1}
                            >
                                {item.label}
                            </Text>
                            {item.detail ? (
                                <Text
                                    style={[styles.detail, { color: theme.colors.text.secondary }]}
                                    numberOfLines={1}
                                >
                                    {item.detail}
                                </Text>
                            ) : null}
                        </View>
                    </View>
                );
            })}
        </View>
    );
});

const stylesheet = StyleSheet.create(() => ({
    container: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    badge: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    icon: {
        marginRight: 10,
    },
    badgeText: {
        flex: 1,
    },
    label: {
        ...Typography.default('regular'),
        fontSize: 14,
        lineHeight: 18,
    },
    detail: {
        ...Typography.default('regular'),
        fontSize: 12,
        lineHeight: 16,
    },
}));
