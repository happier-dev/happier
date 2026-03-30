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
        color: theme.colors.textSecondary,
    },
    input: {
        backgroundColor: theme.colors.input.background,
        color: theme.colors.input.text,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        borderWidth: 0.5,
        paddingHorizontal: 12,
        paddingVertical: 10,
        ...SETTINGS_TEXT_INPUT_METRICS,
    },
}));

export const MachineSetupTextField = React.memo(function MachineSetupTextField(props: Readonly<{
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
    onChangeText: (value: string) => void;
}>) {
    const { theme } = useUnistyles();
    return (
        <View style={[styles.container, props.style]}>
            <Text style={styles.label}>{props.label}</Text>
            <TextInput
                testID={props.testID}
                value={props.value}
                editable={props.editable}
                autoCapitalize={props.autoCapitalize}
                autoCorrect={props.autoCorrect}
                keyboardType={props.keyboardType}
                multiline={props.multiline}
                placeholder={props.placeholder}
                placeholderTextColor={props.placeholderTextColor ?? theme.colors.input.placeholder}
                style={[styles.input, props.inputStyle]}
                onChangeText={props.onChangeText}
            />
        </View>
    );
});
