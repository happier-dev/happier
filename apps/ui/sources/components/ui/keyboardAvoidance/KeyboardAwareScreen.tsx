import * as React from 'react';
import type { StyleProp, ViewProps, ViewStyle } from 'react-native';
import { Platform, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { DEFAULT_KEYBOARD_AWARE_SCREEN_MODE } from './keyboardAvoidanceDefaults';
import {
    resolveKeyboardAwareScreenDefaults,
    type KeyboardAvoidancePlatform,
    type KeyboardAwareScreenMode,
} from './keyboardAvoidanceGeometry';

export type KeyboardAwareScreenProps = ViewProps & Readonly<{
    mode?: Exclude<KeyboardAwareScreenMode, 'scrollForm'>;
    contentContainerStyle?: StyleProp<ViewStyle>;
    keyboardVerticalOffset?: number;
    enabled?: boolean;
}>;

function renderContent(children: React.ReactNode, contentContainerStyle: StyleProp<ViewStyle> | undefined) {
    if (!contentContainerStyle) {
        return children;
    }

    return <View style={contentContainerStyle}>{children}</View>;
}

export const KeyboardAwareScreen = React.forwardRef<View, KeyboardAwareScreenProps>(
    function KeyboardAwareScreen(
        {
            children,
            mode = DEFAULT_KEYBOARD_AWARE_SCREEN_MODE,
            contentContainerStyle,
            keyboardVerticalOffset,
            enabled,
            ...props
        },
        ref,
    ) {
        const defaults = resolveKeyboardAwareScreenDefaults({
            mode,
            platform: Platform.OS as KeyboardAvoidancePlatform,
            keyboardVerticalOffset,
        });

        if (!defaults.useKeyboardController) {
            return (
                <View ref={ref} {...props}>
                    {renderContent(children, contentContainerStyle)}
                </View>
            );
        }

        return (
            <KeyboardAvoidingView
                ref={ref}
                behavior={defaults.behavior}
                enabled={enabled ?? defaults.enabled}
                keyboardVerticalOffset={defaults.keyboardVerticalOffset}
                {...props}
            >
                {renderContent(children, contentContainerStyle)}
            </KeyboardAvoidingView>
        );
    },
);
