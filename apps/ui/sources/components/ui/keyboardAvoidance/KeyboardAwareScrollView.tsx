import * as React from 'react';
import type { ScrollViewProps } from 'react-native';
import { Platform, ScrollView } from 'react-native';
import {
    KeyboardAwareScrollView as RNKCKeyboardAwareScrollView,
    type KeyboardAwareScrollViewProps as RNKCKeyboardAwareScrollViewProps,
    type KeyboardAwareScrollViewRef as RNKCKeyboardAwareScrollViewRef,
} from 'react-native-keyboard-controller';

import { DEFAULT_KEYBOARD_AWARE_SCREEN_MODE } from './keyboardAvoidanceDefaults';
import {
    resolveKeyboardAwareScrollViewDefaults,
    type KeyboardAvoidancePlatform,
    type KeyboardAwareScreenMode,
} from './keyboardAvoidanceGeometry';

export type KeyboardAwareScrollViewProps = ScrollViewProps
    & Pick<RNKCKeyboardAwareScrollViewProps, 'disableScrollOnKeyboardHide' | 'extraKeyboardSpace'>
    & Readonly<{
        mode?: Extract<KeyboardAwareScreenMode, 'scrollForm'>;
        keyboardVerticalOffset?: number;
        bottomOffset?: number;
        enabled?: boolean;
        ScrollViewComponent?: React.ComponentType<ScrollViewProps>;
    }>;

export const KeyboardAwareScrollView = React.forwardRef<ScrollView, KeyboardAwareScrollViewProps>(
    function KeyboardAwareScrollView(
        {
            mode = 'scrollForm',
            keyboardVerticalOffset,
            bottomOffset,
            enabled,
            automaticallyAdjustKeyboardInsets,
            disableScrollOnKeyboardHide,
            extraKeyboardSpace,
            ScrollViewComponent,
            ...props
        },
        ref,
    ) {
        const defaults = resolveKeyboardAwareScrollViewDefaults({
            mode: mode ?? DEFAULT_KEYBOARD_AWARE_SCREEN_MODE,
            platform: Platform.OS as KeyboardAvoidancePlatform,
            keyboardVerticalOffset,
        });

        if (!defaults.useKeyboardController) {
            const scrollRef = ref as React.Ref<ScrollView>;

            if (ScrollViewComponent) {
                return (
                    <ScrollViewComponent
                        automaticallyAdjustKeyboardInsets={automaticallyAdjustKeyboardInsets}
                        {...props}
                    />
                );
            }

            return (
                <ScrollView
                    ref={scrollRef}
                    automaticallyAdjustKeyboardInsets={automaticallyAdjustKeyboardInsets}
                    {...props}
                />
            );
        }
        // RNKC types require a Reanimated ScrollView, but app list wrappers accept the
        // same ScrollView prop surface and RNKC forwards compatible scroll props.
        const ControllerScrollViewComponent =
            ScrollViewComponent as RNKCKeyboardAwareScrollViewProps['ScrollViewComponent'] | undefined;
        const controllerRef = ref as React.Ref<RNKCKeyboardAwareScrollViewRef>;

        return (
            <RNKCKeyboardAwareScrollView
                ref={controllerRef}
                automaticallyAdjustKeyboardInsets={automaticallyAdjustKeyboardInsets ?? defaults.automaticallyAdjustKeyboardInsets}
                bottomOffset={bottomOffset ?? defaults.bottomOffset}
                disableScrollOnKeyboardHide={disableScrollOnKeyboardHide}
                enabled={enabled ?? defaults.enabled}
                extraKeyboardSpace={extraKeyboardSpace}
                ScrollViewComponent={ControllerScrollViewComponent}
                {...props}
            />
        );
    },
);
