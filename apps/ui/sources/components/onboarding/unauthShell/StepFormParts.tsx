import { HappierDivider } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
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
/**
 * A step's fields as one block (lab direction A `.r4-fieldrow`): a readable 420 px column centred under the heading,
 * its groups a group apart (16 px), whatever the step column's width.
 */
export function StepForm(props: Readonly<{ children: React.ReactNode; testID?: string }>) {
    return <View testID={props.testID} style={styles.form}>{props.children}</View>;
}

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

/**
 * The one centred "or" between two ways to do the same thing: two decorative hairlines from the shared divider with the
 * word on the column's axis. The whole divider is hidden from assistive technology; the ways it separates are named.
 */
export function StepOrDivider(props: Readonly<{ label: string }>) {
    const { theme } = useUnistyles();
    return (
        <View testID="step-or-divider" style={styles.or} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <HappierDivider decorative color={theme.colors.border.default} style={styles.orRule} />
            <Text style={styles.orText}>{props.label}</Text>
            <HappierDivider decorative color={theme.colors.border.default} style={styles.orRule} />
        </View>
    );
}

/**
 * A step's quiet way on under its actions ("Lost your key?", "Back to sign in"): the shared text action, centred on
 * the column like the primary above it (lab direction A `.r3-quiet`).
 */
export function StepQuietAction(props: Readonly<{ label: string; onPress: () => void; testID?: string; disabled?: boolean }>) {
    return (
        <View style={styles.quiet}>
            <TextLinkButton testID={props.testID} label={props.label} onPress={props.onPress} disabled={props.disabled} />
        </View>
    );
}

/** The fields' readable width on a computer (lab direction A). */
const STEP_FORM_MAX_WIDTH_PX = 420;

const styles = StyleSheet.create((theme) => ({
    form: {
        width: '100%',
        maxWidth: STEP_FORM_MAX_WIDTH_PX,
        alignSelf: 'center',
        gap: theme.space.s16,
    },
    // Label → field → its line: 6 px apart (lab direction A rhythm 6 / 16 / 24).
    group: {
        width: '100%',
        gap: theme.space.s6,
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
        color: theme.colors.state.danger.textForeground,
    },
    quiet: {
        alignItems: 'center',
    },
    // The rule's width on every step (lab direction A: 380 px, centred), whatever the column around it.
    or: {
        width: '100%',
        maxWidth: 380,
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
    },
    // Both strokes share the row equally, so the word sits on the column's axis whatever its length.
    orRule: {
        flex: 1,
        flexBasis: 0,
        alignSelf: 'center',
    },
    orText: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
}));
