import { type ViewStyle } from 'react-native';
import type { CSSProperties } from 'react';

function shouldDisableBackdropBlurFromWebPreference(): boolean {
    if (typeof document === 'undefined') return false;
    return document.documentElement?.dataset?.happyBackdropBlur === 'off';
}

export function createBackdropWebStyle(params: Readonly<{
    backgroundColor: string;
    blurPx?: number;
    enableBlur?: boolean;
    fallbackBackgroundColorWhenBlurDisabled?: string;
}>): CSSProperties {
    if (params.enableBlur === false || shouldDisableBackdropBlurFromWebPreference()) {
        return {
            backgroundColor: params.fallbackBackgroundColorWhenBlurDisabled ?? params.backgroundColor,
        };
    }

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
