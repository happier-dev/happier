import type { GlyphLayer } from '@happier-dev/brand/glyph-scene';
import type { SkCanvas, SkPicture } from '@shopify/react-native-skia';
import type * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

export type GlyphViewport = Readonly<{
    get: () => 'hidden' | 'backdrop' | 'all';
    subscribe: (listener: () => void) => () => void;
}>;

export type GlyphSurfaceReadiness = 'ready' | 'still';
export type GlyphMotion =
    | Readonly<{ kind: 'transition'; epoch: number; durationS: number; onSettled?: () => void }>
    | Readonly<{ kind: 'sequence'; readTimeS?: (nowMs: number) => number; continues: (seconds: number) => boolean; onSuspended?: () => void }>
    | Readonly<{ kind: 'elapsed'; durationS: number; paused: boolean }>
    | Readonly<{ kind: 'field-calm'; epoch: number; durationS: number; readDurationS?: () => number; onSettled?: () => void }>
    | null;

export type GlyphSurfaceProps = Readonly<{
    width: number;
    height: number;
    scene: readonly GlyphLayer[] | ((seconds: number, readiness?: GlyphSurfaceReadiness, digitSeconds?: number) => readonly GlyphLayer[]);
    motion?: GlyphMotion;
    viewport?: GlyphViewport;
    digitCadence?: boolean;
    theme?: 'light' | 'dark';
    cell?: readonly [number, number];
    pixelRatio?: number;
    onReady?: (status: GlyphSurfaceReadiness) => void;
    onPaint?: () => void;
    /** The displayed browser backing store is readable during this paint turn. */
    onWebPaint?: (canvas: HTMLCanvasElement | null) => void;
    /** Records a native picture with glyphs between any host-owned vector layers. */
    composePicture?: (drawGlyphs: (canvas: SkCanvas) => void, previous: SkPicture | null) => SkPicture;
    /** Draws a frame when a composed moment also owns cover and handoff timing. */
    drawAtRef?: React.RefObject<((seconds: number) => void) | null>;
    /** An admitted hidden presenter can prepare one frame before it is shown. */
    warmWhenHidden?: boolean;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>;
