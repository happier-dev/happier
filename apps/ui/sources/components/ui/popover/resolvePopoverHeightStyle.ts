import type { ViewStyle } from 'react-native';

export function resolvePopoverHeightStyle(maxHeight: number | undefined): ViewStyle | null {
    if (maxHeight === undefined) return null;
    return { maxHeight };
}
