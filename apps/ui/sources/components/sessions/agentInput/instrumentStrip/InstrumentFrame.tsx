import * as React from 'react';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';

/** The instrument's animated DOM owner, shared by every badge and gauge in the strip. */
export function InstrumentFrame({ children, ...props }: Readonly<
    Pick<React.ComponentProps<typeof Animated.View>, 'style' | 'exiting'> & { children: React.ReactNode }
>) {
    return (
        <Animated.View {...props}>
            {/* Web exiting moves direct children, including when Chat freezes. Keep React's
                changing badge children under a stable parent while that frame is moved. */}
            <View collapsable={false}>{children}</View>
        </Animated.View>
    );
}
