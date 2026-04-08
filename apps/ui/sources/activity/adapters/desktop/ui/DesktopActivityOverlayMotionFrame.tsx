import * as React from 'react';
import { Animated } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

export function DesktopActivityOverlayMotionFrame(props: Readonly<{
    visible: boolean;
    expanded: boolean;
    children: React.ReactNode;
}>): React.ReactElement {
    const reduceMotion = useReducedMotionPreference();
    const progress = React.useRef(new Animated.Value(props.visible ? 1 : 0)).current;

    React.useEffect(() => {
        Animated.timing(progress, {
            toValue: props.visible ? 1 : 0,
            duration: reduceMotion ? motionTokens.durationMs.instant : motionTokens.durationMs.base,
            easing: motionTokens.easing.standard,
            useNativeDriver: false,
        }).start();
    }, [progress, props.visible, reduceMotion]);

    const translateY = progress.interpolate({
        inputRange: [0, 1],
        outputRange: [props.expanded ? 5 : 4, 0],
    });
    const scale = progress.interpolate({
        inputRange: [0, 1],
        outputRange: [props.expanded ? 0.992 : 0.994, 1],
    });

    return (
        <Animated.View
            style={[
                styles.frame,
                {
                    opacity: progress,
                    transform: [{ translateY }, { scale }],
                },
            ]}
        >
            {props.children}
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    frame: {
        flex: 1,
        alignSelf: 'stretch',
        width: '100%',
    },
});
