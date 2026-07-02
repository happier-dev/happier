import * as React from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { useComposerKeyboardLayout } from './ComposerKeyboardContext';

export function ComposerKeyboardFloatingInset(props: Readonly<{
    baseBottom?: number;
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>): React.ReactElement {
    const layout = useComposerKeyboardLayout();
    const baseBottom = props.baseBottom ?? 0;
    const animatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: -(layout?.listBottomInset.value ?? 0) }],
    }), [layout]);

    return (
        <Animated.View
            pointerEvents="box-none"
            testID={props.testID}
            style={[props.style, { bottom: baseBottom }, animatedStyle]}
        >
            {props.children}
        </Animated.View>
    );
}
