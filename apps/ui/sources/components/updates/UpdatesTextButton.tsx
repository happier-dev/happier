import * as React from 'react';
import { Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Typography } from '@/constants/Typography';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

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
        <HappierPressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel ?? props.label}
            disabled={props.busy}
            busy={props.busy === true}
            onPress={props.onPress}
            style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}
        >
            {props.busy ? <ActivitySpinner size={12} testID={`${props.testID}.spinner`} /> : null}
            <Text style={styles.label}>{props.label}</Text>
        </HappierPressable>
    );
});

const styles = StyleSheet.create((theme) => ({
    button: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        justifyContent: 'center',
    },
    pressed: {
        opacity: 0.6,
    },
    label: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.secondary,
    },
}));
