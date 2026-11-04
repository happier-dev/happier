import * as React from 'react';
import type { ScrollViewProps } from 'react-native';
import { Platform, ScrollView } from 'react-native';
import {
    KeyboardAwareScrollView as RNKCKeyboardAwareScrollView,
    type KeyboardAwareScrollViewProps as RNKCKeyboardAwareScrollViewProps,
    type KeyboardAwareScrollViewRef as RNKCKeyboardAwareScrollViewRef,
} from 'react-native-keyboard-controller';

import { useWebScrollReadingAnchor } from '@/components/ui/scroll/webScrollReadingAnchor';

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

        // Web pages recompose across breakpoints; the reading anchor keeps what the person was reading in place.
        const anchoredRef = React.useRef<ScrollView | null>(null);
        const anchorsReading = Platform.OS === 'web' && !defaults.useKeyboardController && !ScrollViewComponent;
        useWebScrollReadingAnchor(anchoredRef, anchorsReading);
        const setScrollRef = React.useCallback((node: ScrollView | null) => {
            anchoredRef.current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) ref.current = node;
        }, [ref]);

        if (!defaults.useKeyboardController) {

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
                    ref={setScrollRef}
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
