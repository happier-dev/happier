import type { StyleProp, ViewStyle } from 'react-native';
import type { AtmosphereBackdropJob, AtmosphereFocus, AtmosphereHorizon, AtmospherePixels, AtmosphereSpan } from '@happier-dev/brand/atmosphere';
import type { PictureRecord } from './pictureStore.types';

export type BackdropCanvasSource = PictureRecord | AtmospherePixels;
export type BackdropCanvasProps = Readonly<{
    source: BackdropCanvasSource;
    /** Logical/CSS pixels. Span coordinates use the same units and are scaled once at the adapter. */
    size: { width: number; height: number };
    look: AtmosphereBackdropJob['look'];
    params?: AtmosphereBackdropJob['params'];
    dissolve?: AtmosphereBackdropJob['dissolve'];
    span?: AtmosphereSpan | null;
    focus?: AtmosphereFocus;
    horizon?: AtmosphereHorizon;
    page: AtmosphereBackdropJob['page'];
    theme: AtmosphereBackdropJob['theme'];
    grade?: BackdropGrade | null;
    adjust?: AtmosphereBackdropJob['adjust'];
    toe?: boolean;
    dpr?: number;
    /** Projections of one Horizon scene share its source-scoped rendered pixels. */
    renderGroup?: object;
    /** Decorative/private review paints never inherit the app's Home idle resettle. Default preserves Home. */
    resettle?: boolean;
    /** Current Home idle/focus facts pause finite resettle playback without resetting its clock. */
    resettlePaused?: boolean;
    onReady?: () => void;
    /** The rendered picture's pixels (web: the canvas; native: the shown render, read small): the atmosphere measures its tone. */
    onRendered?: (pixels: AtmospherePixels) => void;
    onError?: (error: Error) => void;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>;

/**
 * The hour grade. A picture's grade names its horizon in the source (`horizon`); the platform turns it
 * into the band row (`hz`) once it has cropped the source, as the lab's `compute` does.
 */
export type BackdropGrade = Readonly<{ from: number; to: number; hz?: number; horizon?: number }>;

export type BackdropRenderRequest = Readonly<{
    source: BackdropCanvasSource;
    width: number;
    height: number;
    focus?: AtmosphereFocus;
    horizon?: AtmosphereHorizon;
    job: Omit<AtmosphereBackdropJob, 'source' | 'grade'> & Readonly<{ grade?: BackdropGrade | null }>;
}>;

export type BackdropWorkerRequest =
    | Readonly<{ cancel: number }>
    | Readonly<{ id: number; sourceId: number; request: BackdropRenderRequest }>
    | Readonly<{ releaseSource: number }>
    | Readonly<{ id: string | number; job: AtmosphereBackdropJob }>;
export type BackdropWorkerResponse =
    | Readonly<{ id: string | number; ok: true; result: AtmospherePixels }>
    | Readonly<{ id: string | number; ok: false; error: string }>;
