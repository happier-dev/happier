import * as React from 'react';
import { View, ViewStyle, StyleProp } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { SurfaceCard } from './SurfaceCard';
import { Icon } from '@/components/ui/icons/Icon';

export interface SummaryCardEntry {
    label: string;
    value: string;
}

export interface SummaryCardProps {
    entries: ReadonlyArray<SummaryCardEntry>;
    onPress?: () => void;
    testID?: string;
    style?: StyleProp<ViewStyle>;
    tone?: 'surface' | 'muted';
}

export const SummaryCard = React.memo<SummaryCardProps>(({ entries, onPress, testID, style, tone = 'surface' }) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    return (
        <SurfaceCard
            testID={testID}
            onPress={onPress}
            tone={tone}
            padding="sm"
            style={style}
        >
        <View
            style={[
                styles.container,
            ]}
        >
            <View style={styles.entriesRow}>
                {entries.map((entry, index) => (
                    <React.Fragment key={entry.label}>
                        {index > 0 && (
                            <Text style={[styles.separator, { color: theme.colors.text.secondary }]}>
                                {' · '}
                            </Text>
                        )}
                        <Text style={[styles.label, { color: theme.colors.text.secondary }]}>
                            {entry.label}:{' '}
                        </Text>
                        <Text style={[styles.value, { color: theme.colors.text.primary }]}>
                            {entry.value}
                        </Text>
                    </React.Fragment>
                ))}
            </View>
            {onPress ? (
                <Icon
                    name="caret-right"
                    size={16}
                    color={theme.colors.text.secondary}
                    style={styles.chevron}
                />
            ) : null}
        </View>
        </SurfaceCard>
    );
});

const stylesheet = StyleSheet.create(() => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
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
