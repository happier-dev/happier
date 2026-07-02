import type { ViewStyle } from 'react-native';

export function resolveInlineDiffVirtualizedViewportStyle(maxHeight: number): ViewStyle {
    return {
        height: maxHeight,
        maxHeight,
        minHeight: 0,
    };
}
