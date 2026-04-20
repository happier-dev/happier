import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

export const SplitCanvasFocusRing = React.memo((props: Readonly<{
    leafId: string;
    visible: boolean;
    keyboardVisible: boolean;
}>) => {
    const { theme } = useUnistyles();

    if (!props.visible) {
        return null;
    }

    return (
        <View
            pointerEvents="none"
            testID={`split-canvas-focus-ring-${props.leafId}`}
            style={{
                position: 'absolute',
                top: 0,
                right: 0,
                bottom: 0,
                left: 0,
                borderWidth: props.keyboardVisible ? 2 : 1,
                borderColor: props.keyboardVisible ? theme.colors.accent.blue : theme.colors.divider,
                borderRadius: 12,
                opacity: props.keyboardVisible ? 0.95 : 0.72,
            }}
        />
    );
});
