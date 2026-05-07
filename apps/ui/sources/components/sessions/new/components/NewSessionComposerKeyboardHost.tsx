import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { useKeyboardHandler, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function NewSessionComposerKeyboardHost(props: Readonly<{
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
}>): React.ReactElement {
    if (Platform.OS !== 'android') {
        return <View style={props.style}>{props.children}</View>;
    }

    const keyboard = useReanimatedKeyboardAnimation();
    const safeArea = useSafeAreaInsets();
    const eagerKeyboardOffset = useSharedValue(0);
    useKeyboardHandler(
        {
            onStart(e) {
                'worklet';
                eagerKeyboardOffset.value = -e.height + safeArea.bottom * e.progress;
            },
            onEnd(e) {
                'worklet';
                eagerKeyboardOffset.value = -e.height + safeArea.bottom * e.progress;
            },
        },
        [safeArea.bottom],
    );
    const animatedStyle = useAnimatedStyle(() => ({
        transform: [{
            translateY: Math.min(
                eagerKeyboardOffset.value,
                keyboard.height.value + safeArea.bottom * keyboard.progress.value,
            ),
        }],
    }), [safeArea.bottom]);

    return (
        <Animated.View style={[props.style, animatedStyle]}>
            {props.children}
        </Animated.View>
    );
}
