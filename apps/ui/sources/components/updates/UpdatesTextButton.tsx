import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Typography } from '@/constants/Typography';

/**
 * The Updates surface's quiet text action ("Check for updates", "Stop after this one", "View log"):
 * the inbox's mark-all-read label style, with the platform hit slop.
 */
export const UpdatesTextButton = React.memo(function UpdatesTextButton(props: Readonly<{
    label: string;
    onPress: () => void;
    testID: string;
    accessibilityLabel?: string;
    busy?: boolean;
}>) {
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel ?? props.label}
            disabled={props.busy}
            accessibilityState={{ busy: props.busy === true, disabled: props.busy === true }}
            hitSlop={Platform.select({ ios: 15, default: 17 })}
            onPress={props.onPress}
            style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}
        >
            {props.busy ? <ActivitySpinner size={12} testID={`${props.testID}.spinner`} /> : null}
            <Text style={styles.label}>{props.label}</Text>
        </Pressable>
    );
});

const styles = StyleSheet.create((theme) => ({
    button: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        justifyContent: 'center',
    },
    pressed: {
        opacity: 0.6,
    },
    label: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        lineHeight: 14,
        color: theme.colors.text.secondary,
    },
}));
