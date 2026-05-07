import type { CSSProperties } from 'react';
import type { ViewStyle } from 'react-native';

export function createBackdropWebStyle(params: Readonly<{
    backgroundColor: string;
    blurPx?: number;
}>): CSSProperties {
    const blurPx = typeof params.blurPx === 'number' ? params.blurPx : 12;
    return {
        WebkitBackdropFilter: `blur(${blurPx}px)`,
        backdropFilter: `blur(${blurPx}px)`,
        backgroundColor: params.backgroundColor,
    };
}

export function createBackdropNativeStyle(params: Readonly<{
    backgroundColor: string;
}>): ViewStyle {
    return {
        backgroundColor: params.backgroundColor,
    };
}
