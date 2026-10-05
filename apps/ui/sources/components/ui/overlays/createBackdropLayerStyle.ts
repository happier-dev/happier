import { type ViewStyle } from 'react-native';
import type { CSSProperties } from 'react';
import type { GlassSurfaceGroup } from '@/components/ui/glass/glassMaterial';

export function createBackdropWebStyle(params: Readonly<{
    backgroundColor: string;
    blurPx?: number;
    enableBlur?: boolean;
    fallbackBackgroundColorWhenBlurDisabled?: string;
    surfaceGroup?: GlassSurfaceGroup;
}>): CSSProperties {
    if (params.enableBlur === false) {
        return {
            backgroundColor: params.fallbackBackgroundColorWhenBlurDisabled ?? params.backgroundColor,
        };
    }

    const blurPx = typeof params.blurPx === 'number' ? params.blurPx : 12;
    const group = params.surfaceGroup ?? 'floating';
    return {
        WebkitBackdropFilter: `blur(var(--happier-glass-${group}-blur, ${blurPx}px))`,
        backdropFilter: `blur(var(--happier-glass-${group}-blur, ${blurPx}px))`,
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
