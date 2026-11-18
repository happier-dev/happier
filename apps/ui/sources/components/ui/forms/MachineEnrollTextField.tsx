import * as React from 'react';
import { View, type StyleProp, type ViewStyle, type TextInputProps as RNTextInputProps } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: theme.space.s8,
    },
    label: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
    },
    support: {

        color: theme.colors.text.secondary,
        ...Typography.variant('body'),

    },
    error: {
        color: theme.colors.state.danger.textForeground,
    },
}));

/** A form field's label and its one line of help: the field draws them, and a control that is not a text input (a choice) uses them too. */
export function MachineEnrollFieldLabel(props: Readonly<{ children: string }>) {
    return <Text style={styles.label}>{props.children}</Text>;
}
export function MachineEnrollFieldSupport(props: Readonly<{ children: string }>) {
    return <Text style={styles.support}>{props.children}</Text>;
}

export type MachineEnrollTextFieldProps = Readonly<{
    editable?: boolean;
    keyboardType?: RNTextInputProps['keyboardType'];
    label: string;
    placeholder?: string;
    style?: StyleProp<ViewStyle>;
    testID?: string;
    value: string;
    autoCapitalize?: RNTextInputProps['autoCapitalize'];
    multiline?: boolean;
    secureTextEntry?: boolean;
    supportText?: string;
    errorText?: string;
    onChangeText: (value: string) => void;
}>;

/** A form's labelled text field: the label above, the shared field box, and its one line of help or refusal beneath. */
export const MachineEnrollTextField = React.memo(React.forwardRef<React.ElementRef<typeof TextInput>, MachineEnrollTextFieldProps>(function MachineEnrollTextField(props, ref) {
    const generatedSupportId = React.useId();
    const supportId = props.testID ? `${props.testID}-support` : `machine-enroll-field-support-${generatedSupportId}`;
    const supportText = props.errorText ?? props.supportText;
    return (
        <View style={[styles.container, props.style]}>
            <MachineEnrollFieldLabel>{props.label}</MachineEnrollFieldLabel>
            <FieldTextInput
                ref={ref}
                testID={props.testID}
                accessibilityLabel={props.label}
                accessibilityHint={supportText}
                accessibilityDescribedBy={supportText ? supportId : undefined}
                invalid={Boolean(props.errorText)}
                value={props.value}
                editable={props.editable}
                autoCapitalize={props.autoCapitalize}
                keyboardType={props.keyboardType}
                multiline={props.multiline}
                secureTextEntry={props.secureTextEntry}
                placeholder={props.placeholder}
                onChangeText={props.onChangeText}
            />
            {supportText ? (
                <Text accessibilityLiveRegion="polite" nativeID={supportId} style={[styles.support, props.errorText ? styles.error : null]}>
                    {supportText}
                </Text>
            ) : null}
        </View>
    );
}));
