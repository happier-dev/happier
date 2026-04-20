import * as React from 'react';
import { View, type DimensionValue, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { SplitCanvasDropTarget } from '../model/splitCanvasTypes';

function resolveOverlayGeometry(placement: SplitCanvasDropTarget['placement']): Readonly<{
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
    width?: DimensionValue;
    height?: DimensionValue;
    borderLeftWidth?: number;
    borderRightWidth?: number;
    borderTopWidth?: number;
    borderBottomWidth?: number;
}> {
    switch (placement) {
        case 'left':
            return {
                top: 0,
                bottom: 0,
                left: 0,
                width: '50%',
                borderRightWidth: 2,
            };
        case 'right':
            return {
                top: 0,
                right: 0,
                bottom: 0,
                width: '50%',
                borderLeftWidth: 2,
            };
        case 'up':
            return {
                top: 0,
                left: 0,
                right: 0,
                height: '50%',
                borderBottomWidth: 2,
            };
        case 'down':
            return {
                left: 0,
                right: 0,
                bottom: 0,
                height: '50%',
                borderTopWidth: 2,
            };
        case 'center':
        default:
            return {
                top: 0,
                right: 0,
                bottom: 0,
                left: 0,
            };
    }
}

export const SplitCanvasDropOverlay = React.memo((props: Readonly<{
    target: SplitCanvasDropTarget | null;
}>) => {
    const { theme } = useUnistyles();
    if (!props.target) return null;
    const geometry = resolveOverlayGeometry(props.target.placement);
    const overlayStyle: ViewStyle = {
        position: 'absolute',
        ...geometry,
        borderRadius: 12,
        borderWidth: props.target.placement === 'center' ? 2 : 1,
        borderColor: theme.colors.accent.blue,
        backgroundColor: theme.colors.accent.blue,
        opacity: props.target.placement === 'center' ? 0.12 : 0.18,
    };

    return (
        <View
            pointerEvents="none"
            testID={`split-canvas-drop-overlay-${props.target.leafId}-${props.target.placement}`}
            style={overlayStyle}
        >
            <View
                pointerEvents="none"
                testID={`split-canvas-drop-edge-${props.target.leafId}-${props.target.placement}`}
                style={{
                    flex: 1,
                    borderRadius: 11,
                    borderWidth: props.target.placement === 'center' ? 0 : 1,
                    borderColor: theme.colors.accent.blue,
                    opacity: 0.75,
                }}
            />
        </View>
    );
});
