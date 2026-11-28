import * as React from 'react';
import { Pressable } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * The plans surfaces' quiet text action: a semibold label with no pill or inset, so it sits flush
 * with the edge of whatever it aligns to. The hit area grows past the text instead of the text
 * moving in.
 */
export function PlanTextLink(props: Readonly<{ label: string; onPress: () => void; testID?: string; disabled?: boolean }>) {
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityState={{ disabled: props.disabled === true }}
            disabled={props.disabled}
            onPress={props.onPress}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
            style={({ pressed }) => [styles.link, pressed || props.disabled ? styles.linkDimmed : null]}
        >
            <Text style={styles.linkText}>{props.label}</Text>
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    link: {
        paddingVertical: 2,
    },
    linkDimmed: {
        opacity: 0.6,
    },
    linkText: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text.primary,
    },
}));
