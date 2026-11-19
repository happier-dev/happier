import type { GlyphLayer } from '@happier-dev/brand/glyph-scene';
import type { StyleProp, ViewStyle } from 'react-native';

export type GlyphSurfaceReadiness = 'ready' | 'still';
export type GlyphMotion =
    | Readonly<{ kind: 'transition'; epoch: number; durationS: number; onSettled?: () => void }>
    | Readonly<{ kind: 'digits' }>
    | Readonly<{ kind: 'field-calm'; epoch: number; durationS: number; readDurationS?: () => number; onSettled?: () => void }>
    | null;

export type GlyphSurfaceProps = Readonly<{
    width: number;
    height: number;
    scene: readonly GlyphLayer[] | ((seconds: number) => readonly GlyphLayer[]);
    motion?: GlyphMotion;
    theme?: 'light' | 'dark';
    cell?: readonly [number, number];
    onReady?: (status: GlyphSurfaceReadiness) => void;
    onPaint?: () => void;
    /** An admitted hidden presenter can prepare one frame before it is shown. */
    warmWhenHidden?: boolean;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>;
