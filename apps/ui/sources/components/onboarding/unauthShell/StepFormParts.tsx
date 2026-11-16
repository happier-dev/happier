import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * The parts every signed-out form is made of, so Login, the email forms and Connect to a Home read as
 * one anatomy (owner review 11-16): a field's label over its control, one line under the control that
 * says what it is for or why it was refused, and a thin "or" between two ways to do the same thing.
 * The control is the shared `FieldTextInput` at the page control height, its touch target reached by
 * the hit area rather than drawn (a password: `PasswordField` in the page presentation, the same box);
 * an action beside a field is a `normal` `RoundButton`, the same height. A field's parts sit in a
 * `StepFieldGroup`, and a form's groups stand a section apart.
 */
export function StepFieldGroup(props: Readonly<{ children: React.ReactNode; testID?: string }>) {
    return <View testID={props.testID} style={styles.group}>{props.children}</View>;
}

export function StepFieldLabel(props: Readonly<{ children: string; nativeID?: string }>) {
    return <Text nativeID={props.nativeID} style={styles.label}>{props.children}</Text>;
}

export function StepFieldHelp(props: Readonly<{
    children: React.ReactNode;
    tone?: 'help' | 'error';
    testID?: string;
    nativeID?: string;
}>) {
    const error = props.tone === 'error';
    return (
        <Text
            testID={props.testID}
            nativeID={props.nativeID}
            style={error ? styles.error : styles.help}
            accessibilityRole={error ? 'alert' : undefined}
            accessibilityLiveRegion={error ? 'polite' : undefined}
        >
            {props.children}
        </Text>
    );
}

/** The label's look for an owner that draws its own label (`PasswordField`); read while rendering. */
export function stepFieldLabelStyle() {
    return styles.label;
}

/** A thin rule with "or" in the middle, between two ways to do the same thing. */
export function StepOrDivider(props: Readonly<{ label: string }>) {
    return (
        <View style={styles.or} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <View style={styles.orRule} />
            <Text style={styles.orText}>{props.label}</Text>
            <View style={styles.orRule} />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    group: {
        width: '100%',
        gap: theme.space.s8,
    },
    label: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    help: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    error: {
        ...Typography.variant('meta'),
        color: theme.colors.state.danger.foreground,
    },
    or: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
    },
    orRule: {
        flex: 1,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.border.default,
    },
    orText: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
}));
