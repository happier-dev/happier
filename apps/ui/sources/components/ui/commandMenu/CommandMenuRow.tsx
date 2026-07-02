import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';

interface CommandMenuRowProps {
    label: string;
    description?: string;
    icon?: React.ReactNode;
    testID?: string;
}

/**
 * Default row renderer for CommandMenu. Thin component that SelectionList
 * instantiates per-row via the `content` field of `SelectionListOption`.
 *
 * Renders: [icon?] [label] [description?]
 */
export const CommandMenuRow = React.memo((props: CommandMenuRowProps) => {
    const { label, description, icon, testID } = props;

    return (
        <View style={styles.container} testID={testID}>
            {icon != null && (
                <View style={styles.iconContainer} testID={testID ? `${testID}:icon` : undefined}>
                    {icon}
                </View>
            )}
            <View style={styles.textContainer}>
                <Text style={styles.label} numberOfLines={1}>
                    {label}
                </Text>
                {description != null && (
                    <Text style={styles.description} numberOfLines={1}>
                        {description}
                    </Text>
                )}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 10,
    },
    iconContainer: {
        width: 20,
        height: 20,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    textContainer: {
        flex: 1,
        flexDirection: 'column',
        gap: 2,
    },
    label: {
        color: theme.colors.text.primary,
        fontSize: 14,
    },
    description: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
}));
