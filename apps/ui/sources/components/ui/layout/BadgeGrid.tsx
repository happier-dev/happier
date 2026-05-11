import * as React from 'react';
import { View, ViewStyle, StyleProp } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
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

const STATUS_ICON: Record<BadgeGridItem['status'], { name: string; color: string }> = {
    positive: { name: 'checkmark-circle', color: '#34C759' },
    negative: { name: 'close-circle', color: '#FF3B30' },
    neutral: { name: 'ellipse', color: '#8E8E93' },
    warning: { name: 'warning', color: '#FF9500' },
};

export const BadgeGrid = React.memo<BadgeGridProps>(({ items, columns = 3, testID, style }) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    // Approximate minWidth so badges wrap at the right column count
    const minWidth = columns === 2 ? '45%' : '28%';

    return (
        <View testID={testID} style={[styles.container, style]}>
            {items.map((item) => {
                const icon = STATUS_ICON[item.status];
                return (
                    <View key={item.id} style={[styles.badge, { minWidth }]}>
                        <Ionicons
                            name={icon.name as any}
                            size={16}
                            color={icon.color}
                            style={styles.icon}
                        />
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
