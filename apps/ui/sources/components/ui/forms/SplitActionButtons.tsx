import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';

export const SplitActionButtons = React.memo(function SplitActionButtons(props: Readonly<{
    secondaryLabel?: string;
    onSecondaryPress?: () => void;
    secondaryTestID?: string;
    secondaryDestructive?: boolean;
    primaryLabel: string;
    onPrimaryPress: () => void;
    primaryDisabled?: boolean;
    primaryTestID?: string;
}>) {
    const { theme } = useUnistyles();

    return (
        <View style={styles.actionsRow}>
            {props.secondaryLabel && props.onSecondaryPress ? (
                <View style={styles.buttonContainer}>
                    <Pressable
                        testID={props.secondaryTestID}
                        onPress={props.onSecondaryPress}
                        accessibilityRole="button"
                        accessibilityLabel={props.secondaryLabel}
                        style={({ pressed }) => ({
                            backgroundColor: theme.colors.surface.base,
                            borderRadius: 10,
                            paddingVertical: 12,
                            alignItems: 'center',
                            opacity: pressed ? 0.85 : 1,
                        })}
                    >
                        <Text
                            style={{
                                color: props.secondaryDestructive ? theme.colors.state.danger.foreground : theme.colors.text.primary,
                                ...Typography.default('semiBold'),
                            }}
                        >
                            {props.secondaryLabel}
                        </Text>
                    </Pressable>
                </View>
            ) : null}

            <View style={styles.buttonContainer}>
                <Pressable
                    testID={props.primaryTestID}
                    onPress={props.onPrimaryPress}
                    disabled={props.primaryDisabled}
                    accessibilityRole="button"
                    accessibilityLabel={props.primaryLabel}
                    style={({ pressed }) => ({
                        backgroundColor: theme.colors.button.primary.background,
                        borderRadius: 10,
                        paddingVertical: 12,
                        alignItems: 'center',
                        opacity: props.primaryDisabled ? 0.5 : (pressed ? 0.85 : 1),
                    })}
                >
                    <Text style={{ color: theme.colors.button.primary.tint, ...Typography.default('semiBold') }}>
                        {props.primaryLabel}
                    </Text>
                </Pressable>
            </View>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    actionsRow: {
        flexDirection: 'row',
        gap: 12,
    },
    buttonContainer: {
        flex: 1,
    },
}));
