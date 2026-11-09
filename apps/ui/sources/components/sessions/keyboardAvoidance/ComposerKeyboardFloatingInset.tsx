import * as React from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { useComposerKeyboardLayout, useComposerOverlayOpen } from './ComposerKeyboardContext';

export function ComposerKeyboardFloatingInset(props: Readonly<{
    baseBottom?: number;
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    testID?: string;
    /** A transcript control that steps aside while a composer overlay (the prompt picker) covers its corner. */
    hideUnderComposerOverlay?: boolean;
}>): React.ReactElement | null {
    const layout = useComposerKeyboardLayout();
    const overlayOpen = useComposerOverlayOpen();
    const baseBottom = props.baseBottom ?? 0;
    const animatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: -(layout?.listBottomInset.value ?? 0) }],
    }), [layout]);

    if (props.hideUnderComposerOverlay && overlayOpen) return null;
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
