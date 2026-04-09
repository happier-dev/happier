import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

const NEW_SESSION_IOS_KEYBOARD_VERTICAL_OFFSET = 16;

export function NewSessionKeyboardContainer(props: Readonly<{
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
}>): React.ReactElement {
    if (Platform.OS !== 'ios') {
        return <View style={props.style}>{props.children}</View>;
    }

    return (
        <KeyboardAvoidingView
            behavior="translate-with-padding"
            automaticOffset
            keyboardVerticalOffset={NEW_SESSION_IOS_KEYBOARD_VERTICAL_OFFSET}
            style={props.style}
        >
            {props.children}
        </KeyboardAvoidingView>
    );
}
