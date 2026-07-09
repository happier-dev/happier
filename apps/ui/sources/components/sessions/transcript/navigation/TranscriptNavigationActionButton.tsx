import * as React from 'react';
import { Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';

type OcticonName = React.ComponentProps<typeof Octicons>['name'];

export type TranscriptNavigationActionButtonProps = Readonly<{
    iconName: OcticonName;
    accessibilityLabel: string;
    onPress: () => void;
    testID?: string;
    disabled?: boolean;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    button: {
        width: 34,
        height: 34,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    buttonDisabled: {
        opacity: 0.45,
    },
}));

export const TranscriptNavigationActionButton = React.memo((props: TranscriptNavigationActionButtonProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    return (
        <Pressable
            testID={props.testID}
            onPress={props.onPress}
            disabled={props.disabled}
            style={[styles.button, props.disabled ? styles.buttonDisabled : null]}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            accessibilityState={{ disabled: props.disabled === true }}
        >
            <Octicons name={props.iconName} size={16} color={theme.colors.text.secondary} />
        </Pressable>
    );
});
