import type { GlyphLayer } from '@happier-dev/brand/glyph-scene';
import type * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

export type GlyphSurfaceReadiness = 'ready' | 'still';
export type GlyphMotion =
    | Readonly<{ kind: 'transition'; epoch: number; durationS: number; onSettled?: () => void }>
    | Readonly<{ kind: 'digits' }>
    | Readonly<{ kind: 'elapsed'; durationS: number; paused: boolean }>
    | Readonly<{ kind: 'field-calm'; epoch: number; durationS: number; readDurationS?: () => number; onSettled?: () => void }>
    | null;

export type GlyphSurfaceProps = Readonly<{
    width: number;
    height: number;
    scene: readonly GlyphLayer[] | ((seconds: number, readiness?: GlyphSurfaceReadiness) => readonly GlyphLayer[]);
    motion?: GlyphMotion;
    theme?: 'light' | 'dark';
    cell?: readonly [number, number];
    onReady?: (status: GlyphSurfaceReadiness) => void;
    onPaint?: () => void;
    /** Draws a frame when a composed moment also owns cover and handoff timing. */
    drawAtRef?: React.RefObject<((seconds: number) => void) | null>;
    /** An admitted hidden presenter can prepare one frame before it is shown. */
    warmWhenHidden?: boolean;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>;
