import * as React from 'react';
import { View, Pressable, ViewStyle, StyleProp } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

export interface SummaryCardEntry {
    label: string;
    value: string;
}

export interface SummaryCardProps {
    entries: ReadonlyArray<SummaryCardEntry>;
    onPress?: () => void;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}

export const SummaryCard = React.memo<SummaryCardProps>(({ entries, onPress, testID, style }) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const content = (
        <View
            style={[
                styles.container,
                {
                    backgroundColor: theme.colors.surfaceHigh,
                    borderColor: theme.colors.divider,
                },
                style,
            ]}
        >
            <View style={styles.entriesRow}>
                {entries.map((entry, index) => (
                    <React.Fragment key={entry.label}>
                        {index > 0 && (
                            <Text style={[styles.separator, { color: theme.colors.textSecondary }]}>
                                {' · '}
                            </Text>
                        )}
                        <Text style={[styles.label, { color: theme.colors.textSecondary }]}>
                            {entry.label}:{' '}
                        </Text>
                        <Text style={[styles.value, { color: theme.colors.text }]}>
                            {entry.value}
                        </Text>
                    </React.Fragment>
                ))}
            </View>
            {onPress ? (
                <Ionicons
                    name="chevron-forward"
                    size={16}
                    color={theme.colors.textSecondary}
                    style={styles.chevron}
                />
            ) : null}
        </View>
    );

    if (onPress) {
        return (
            <Pressable testID={testID} onPress={onPress}>
                {content}
            </Pressable>
        );
    }

    return <View testID={testID}>{content}</View>;
});

const stylesheet = StyleSheet.create(() => ({
    container: {
        borderRadius: 12,
        borderWidth: 1,
        paddingHorizontal: 14,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
    },
    entriesRow: {
        flex: 1,
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 4,
        columnGap: 2,
        alignItems: 'baseline',
    },
    label: {
        ...Typography.default('regular'),
        fontSize: 13,
        lineHeight: 18,
    },
    value: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        lineHeight: 18,
    },
    separator: {
        ...Typography.default('regular'),
        fontSize: 13,
        lineHeight: 18,
    },
    chevron: {
        marginLeft: 8,
    },
}));
