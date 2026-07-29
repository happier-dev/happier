import * as React from 'react';
import { View, type StyleProp, type TextStyle, type ViewStyle, type TextInputProps as RNTextInputProps } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SETTINGS_TEXT_INPUT_METRICS } from '@/components/ui/forms/settingsTextInputMetrics';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 8,
    },
    label: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
    },
    support: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
    },
    error: {
        color: theme.colors.state.danger.foreground,
    },
    input: {
        backgroundColor: theme.colors.input.background,
        color: theme.colors.input.text,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        borderWidth: 0.5,
        paddingHorizontal: 12,
        paddingVertical: 10,
        ...SETTINGS_TEXT_INPUT_METRICS,
    },
}));

export type MachineSetupTextFieldProps = Readonly<{
    editable?: boolean;
    inputStyle?: StyleProp<TextStyle>;
    keyboardType?: RNTextInputProps['keyboardType'];
    label: string;
    placeholder?: string;
    placeholderTextColor?: string;
    style?: StyleProp<ViewStyle>;
    testID?: string;
    value: string;
    autoCapitalize?: RNTextInputProps['autoCapitalize'];
    autoCorrect?: boolean;
    multiline?: boolean;
    secureTextEntry?: boolean;
    supportText?: string;
    errorText?: string;
    onChangeText: (value: string) => void;
}>;

export const MachineSetupTextField = React.memo(React.forwardRef<React.ElementRef<typeof TextInput>, MachineSetupTextFieldProps>(function MachineSetupTextField(props, ref) {
    const { theme } = useUnistyles();
    const generatedSupportId = React.useId();
    const supportId = props.testID ? `${props.testID}-support` : `machine-setup-field-support-${generatedSupportId}`;
    const supportText = props.errorText ?? props.supportText;
    const describedByProps = supportText ? { accessibilityDescribedBy: supportId } : {};
    return (
        <View style={[styles.container, props.style]}>
            <Text style={styles.label}>{props.label}</Text>
            <TextInput
                ref={ref}
                testID={props.testID}
                accessibilityLabel={props.label}
                accessibilityHint={supportText}
                {...describedByProps}
                accessibilityState={{
                    ...(props.editable === false ? { disabled: true } : {}),
                    ...(props.errorText ? { invalid: true } : {}),
                }}
                value={props.value}
                editable={props.editable}
                autoCapitalize={props.autoCapitalize}
                autoCorrect={props.autoCorrect}
                keyboardType={props.keyboardType}
                multiline={props.multiline}
                secureTextEntry={props.secureTextEntry}
                placeholder={props.placeholder}
                placeholderTextColor={props.placeholderTextColor ?? theme.colors.input.placeholder}
                style={[styles.input, props.inputStyle]}
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
