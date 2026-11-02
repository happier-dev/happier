/** Pure, worklet-safe geometry. Scales are image pixels → viewport points, translations centre-relative. */
export type ZoomSize = Readonly<{ width: number; height: number }>;
export type ZoomPoint = Readonly<{ x: number; y: number }>;
export type ZoomState = ZoomPoint & Readonly<{ scale: number }>;
export type ZoomBounds = Readonly<{ min: number; max: number; natural: number; doubleTap: number }>;

export const STAGE_DISMISS = { minScale: 0.82, commitRatio: 0.3 } as const;
/** UIScrollView's normal deceleration rate, projected in milliseconds. Velocities enter in points/second. */
export const STAGE_DECELERATION_RATE = 0.998;

export function clampZoom(value: number, min: number, max: number): number {
    'worklet';
    return Math.min(max, Math.max(min, value));
}

export function resolveZoomBounds(image: ZoomSize, viewport: ZoomSize, devicePixelRatio: number): ZoomBounds {
    'worklet';
    const min = Math.min(1, viewport.width / image.width, viewport.height / image.height);
    const natural = 1 / devicePixelRatio;
    const target = Math.max(min, Math.min(natural, 3 * min));
    return { min, max: Math.max(natural, 4 * min), natural, doubleTap: target === min ? 2 * min : target };
}

export function panBounds(image: ZoomSize, viewport: ZoomSize, scale: number): ZoomPoint {
    'worklet';
    return { x: Math.max(0, (image.width * scale - viewport.width) / 2), y: Math.max(0, (image.height * scale - viewport.height) / 2) };
}

export function clampPan(point: ZoomPoint, bounds: ZoomPoint): ZoomPoint {
    'worklet';
    return { x: clampZoom(point.x, -bounds.x, bounds.x), y: clampZoom(point.y, -bounds.y, bounds.y) };
}

/** Keeps one content point under the focal point even when the fingers also translate. */
export function focalZoom(state: ZoomState, scale: number, focal: ZoomPoint, nextFocal: ZoomPoint = focal): ZoomState {
    'worklet';
    const ratio = scale / state.scale;
    return { scale, x: nextFocal.x - (focal.x - state.x) * ratio, y: nextFocal.y - (focal.y - state.y) * ratio };
}

export function rubberBandScale(scale: number, bounds: Readonly<{ min: number; max: number }>): number {
    'worklet';
    if (scale < bounds.min) return bounds.min + (scale - bounds.min) * 0.15;
    if (scale > bounds.max) return bounds.max + (scale - bounds.max) * 0.05;
    return scale;
}

/** Integral of (1 - f)^2, with f the fraction of the viewport consumed by elastic displacement. */
export function rubberBandPan(value: number, bound: number, viewportExtent: number): number {
    'worklet';
    const excess = Math.abs(value) - bound;
    if (excess <= 0) return value;
    return Math.sign(value) * (bound + excess / (1 + excess / viewportExtent));
}

export function projectRelease(position: number, velocity: number, rate: number = STAGE_DECELERATION_RATE): number {
    'worklet';
    return position + (velocity / 1000) * rate / (1 - rate);
}

export function dismissPresentation(dy: number, viewportHeight: number): Readonly<{ progress: number; scale: number; backdrop: number }> {
    'worklet';
    const progress = Math.min(1, Math.abs(dy) / (0.33 * viewportHeight));
    return { progress, scale: 1 - (1 - STAGE_DISMISS.minScale) * progress, backdrop: 1 - progress };
}

/** The vertical recognizer has already admitted this drag; stopped releases remain valid. */
export function shouldDismiss(position: ZoomPoint, velocity: ZoomPoint, viewportHeight: number): boolean {
    'worklet';
    return Math.abs(projectRelease(position.y, velocity.y)) > STAGE_DISMISS.commitRatio * viewportHeight;
}

/** Negative drag goes to the next item. The caller owns whether that neighbour exists. */
export function galleryDirection(position: number, velocity: number, viewportWidth: number): -1 | 0 | 1 {
    'worklet';
    if (Math.abs(position) > viewportWidth / 2) return position < 0 ? 1 : -1;
    const projected = projectRelease(position, velocity);
    return Math.abs(projected) > viewportWidth / 2 ? (projected < 0 ? 1 : -1) : 0;
}

export function resizeZoom(state: ZoomState, image: ZoomSize, previous: ZoomSize, viewport: ZoomSize, dpr: number, gestureActive: boolean): ZoomState {
    'worklet';
    if (gestureActive && previous.width === viewport.width) return state;
    const bounds = resolveZoomBounds(image, viewport, dpr);
    // Before the first layout there is no centre content point to preserve.
    if (state.scale === 0) return { scale: bounds.min, x: 0, y: 0 };
    // An unzoomed picture follows fit as the viewport changes; a user zoom keeps its image scale.
    const wasFitted = state.scale === resolveZoomBounds(image, previous, dpr).min;
    const scale = wasFitted ? bounds.min : clampZoom(state.scale, bounds.min, bounds.max);
    // Translations are relative to the centre: retaining t/scale retains its content point.
    const point = clampPan({ x: state.x * scale / state.scale, y: state.y * scale / state.scale }, panBounds(image, viewport, scale));
    return { scale, ...point };
}

export function wheelZoomFactor(deltaY: number): number {
    'worklet';
    return Math.exp(-clampZoom(deltaY, -100, 100) / 150);
}
