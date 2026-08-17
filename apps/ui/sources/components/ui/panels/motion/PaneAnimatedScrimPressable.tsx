import * as React from 'react';
import { Animated, Pressable } from 'react-native';

export const PaneAnimatedScrimPressable = React.memo((props: Readonly<{
    testID: string;
    accessibilityRole: 'button';
    accessibilityLabel?: string;
    accessibilityHint?: string;
    onPress: () => void;
    animatedStyle: React.ComponentProps<typeof Animated.View>['style'];
}>) => {
    return (
        <Animated.View style={props.animatedStyle}>
            <Pressable
                testID={props.testID}
                accessibilityRole={props.accessibilityRole}
                accessibilityLabel={props.accessibilityLabel}
                accessibilityHint={props.accessibilityHint}
                onPress={props.onPress}
                style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
            />
        </Animated.View>
    );
});
