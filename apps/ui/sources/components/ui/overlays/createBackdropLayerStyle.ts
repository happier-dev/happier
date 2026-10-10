import { type ViewStyle } from 'react-native';
import type { CSSProperties } from 'react';
import type { GlassSurfaceGroup } from '@/components/ui/glass/glassMaterial';

export function createBackdropWebStyle(params: Readonly<{
    backgroundColor: string;
    blurPx?: number;
    enableBlur?: boolean;
    fallbackBackgroundColorWhenBlurDisabled?: string;
    surfaceGroup?: GlassSurfaceGroup;
    /** Static tone resolved by the material owner; scrims do not acquire it implicitly. */
    backdropTone?: string;
}>): CSSProperties {
    if (params.enableBlur === false) {
        return {
            backgroundColor: params.fallbackBackgroundColorWhenBlurDisabled ?? params.backgroundColor,
        };
    }

    const blurPx = typeof params.blurPx === 'number' ? params.blurPx : 12;
    const group = params.surfaceGroup ?? 'floating';
    const filter = [`blur(var(--happier-glass-${group}-blur, ${blurPx}px))`, params.backdropTone].filter(Boolean).join(' ');
    return {
        WebkitBackdropFilter: filter,
        backdropFilter: filter,
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
