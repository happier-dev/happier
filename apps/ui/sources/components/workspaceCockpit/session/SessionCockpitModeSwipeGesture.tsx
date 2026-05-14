import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';

export type SessionCockpitModeSwipeDirection = 'open' | 'close';

const SESSION_COCKPIT_MODE_SWIPE_DISTANCE_PX = 36;
const SESSION_COCKPIT_MODE_SWIPE_VELOCITY_Y = 650;
const SESSION_COCKPIT_MODE_SWIPE_MIN_DISTANCE_PX = 8;

export function resolveSessionCockpitModeSwipeIntent(input: Readonly<{
    direction: SessionCockpitModeSwipeDirection;
    translationY: number;
    velocityY: number;
}>): SessionCockpitModeSwipeDirection | null {
    'worklet';
    const signedDistance = input.direction === 'open'
        ? -input.translationY
        : input.translationY;
    const signedVelocity = input.direction === 'open'
        ? -input.velocityY
        : input.velocityY;

    if (
        signedDistance >= SESSION_COCKPIT_MODE_SWIPE_DISTANCE_PX
        || signedVelocity >= SESSION_COCKPIT_MODE_SWIPE_VELOCITY_Y
    ) {
        return input.direction;
    }
    return null;
}

export function SessionCockpitModeSwipeGesture(props: Readonly<{
    direction: SessionCockpitModeSwipeDirection;
    enabled: boolean;
    onIntent: () => void;
    children: React.ReactNode;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}>) {
    const onIntentRef = React.useRef(props.onIntent);
    onIntentRef.current = props.onIntent;

    const gesture = React.useMemo(() => {
        if (!props.enabled) {
            return null;
        }

        const fireIntent = () => {
            onIntentRef.current();
        };

        return Gesture.Pan()
            .minDistance(SESSION_COCKPIT_MODE_SWIPE_MIN_DISTANCE_PX)
            .activeOffsetY([
                -SESSION_COCKPIT_MODE_SWIPE_MIN_DISTANCE_PX,
                SESSION_COCKPIT_MODE_SWIPE_MIN_DISTANCE_PX,
            ])
            .onEnd((event) => {
                'worklet';
                const intent = resolveSessionCockpitModeSwipeIntent({
                    direction: props.direction,
                    translationY: event.translationY,
                    velocityY: event.velocityY,
                });
                if (intent !== null) {
                    scheduleOnRN(fireIntent);
                }
            });
    }, [props.direction, props.enabled]);

    if (!gesture) {
        return <>{props.children}</>;
    }

    return (
        <GestureDetector gesture={gesture}>
            <View collapsable={false} testID={props.testID} style={props.style}>
                {props.children}
            </View>
        </GestureDetector>
    );
}
