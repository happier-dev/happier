export type TranscriptNavigationRailMarkerMotion = Readonly<{
    opacity: number;
    translateYPx: number;
    widthPx: number;
}>;

export type ResolveTranscriptNavigationRailMarkerMotionInput = Readonly<{
    activeIndex: number | null;
    focusIndex: number | null;
    markerIndex: number;
    reducedMotion: boolean;
    visible: boolean;
}>;

export type ResolveTranscriptNavigationRailMotionUpdateIndexesInput = Readonly<{
    markerCount: number;
    nextFocusIndex: number | null;
    previousFocusIndex: number | null;
    radius?: number;
}>;

const REST_WIDTH_PX = 3;
const FOCUS_WIDTH_PX = 16;
const REST_OPACITY = 0.28;
const VISIBLE_OPACITY_FLOOR = 0.56;
const ACTIVE_OPACITY_FLOOR = 0.9;
const FOCUS_OPACITY_FLOOR = 0.7;
const FALLOFF_SIGMA = 1.35;
// Matches the default update-window radius: markers past this distance rest
// exactly so focus changes never restyle the whole rail.
const FALLOFF_WINDOW_RADIUS = 5;

function finiteIntegerOrNull(value: number | null): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function gaussian(distance: number): number {
    if (distance > FALLOFF_WINDOW_RADIUS) return 0;
    return Math.exp(-(distance * distance) / (2 * FALLOFF_SIGMA * FALLOFF_SIGMA));
}

export function resolveTranscriptNavigationRailMarkerMotion(
    input: ResolveTranscriptNavigationRailMarkerMotionInput,
): TranscriptNavigationRailMarkerMotion {
    const markerIndex = finiteIntegerOrNull(input.markerIndex) ?? 0;
    const focusIndex = finiteIntegerOrNull(input.focusIndex);
    const activeIndex = finiteIntegerOrNull(input.activeIndex);
    const focused = focusIndex !== null;
    const distance = focused ? Math.abs(markerIndex - focusIndex) : Number.POSITIVE_INFINITY;
    const falloff = focused ? gaussian(distance) : 0;
    const active = activeIndex !== null && markerIndex === activeIndex;

    const widthPx = input.reducedMotion
        ? REST_WIDTH_PX
        : REST_WIDTH_PX + ((FOCUS_WIDTH_PX - REST_WIDTH_PX) * falloff);
    const opacity = Math.max(
        REST_OPACITY,
        input.visible ? VISIBLE_OPACITY_FLOOR : REST_OPACITY,
        active ? ACTIVE_OPACITY_FLOOR : REST_OPACITY,
        focused ? FOCUS_OPACITY_FLOOR * falloff : REST_OPACITY,
    );

    return {
        opacity: Math.min(1, opacity),
        translateYPx: input.reducedMotion || !focused ? 0 : (markerIndex - (focusIndex ?? markerIndex)) * 0.35 * falloff,
        widthPx,
    };
}

export type TranscriptNavigationRailMarkerMotionStep = Readonly<{
    motion: TranscriptNavigationRailMarkerMotion;
    settled: boolean;
}>;

/**
 * Per-frame smoothing factor for the rail's critically-damped glide toward the
 * resolved marker style. Tuned so magnification eases in over ~8-12 frames at
 * 60fps instead of stepping to the target in one write.
 */
export const RAIL_MARKER_MOTION_SMOOTHING = 0.3;

const SETTLE_EPSILON_PX = 0.25;
const SETTLE_EPSILON_OPACITY = 0.01;

function isRenderableMotion(motion: TranscriptNavigationRailMarkerMotion | null | undefined): motion is TranscriptNavigationRailMarkerMotion {
    return (
        !!motion &&
        Number.isFinite(motion.opacity) &&
        Number.isFinite(motion.translateYPx) &&
        Number.isFinite(motion.widthPx)
    );
}

export function transcriptNavigationRailMarkerMotionEquals(
    left: TranscriptNavigationRailMarkerMotion,
    right: TranscriptNavigationRailMarkerMotion,
): boolean {
    return (
        left.opacity === right.opacity &&
        left.translateYPx === right.translateYPx &&
        left.widthPx === right.widthPx
    );
}

/**
 * Advances an in-flight marker style one frame toward its target with a lerp
 * (`value + (target - value) * smoothing`), snapping exactly onto the target
 * once every channel is within its settle epsilon. Broken inputs (missing or
 * non-finite current values, non-finite smoothing) settle immediately so the
 * rail can never animate from — or toward — garbage.
 */
export function stepTranscriptNavigationRailMarkerMotion(
    current: TranscriptNavigationRailMarkerMotion | null | undefined,
    target: TranscriptNavigationRailMarkerMotion,
    smoothing: number = RAIL_MARKER_MOTION_SMOOTHING,
): TranscriptNavigationRailMarkerMotionStep {
    const factor = Number.isFinite(smoothing) ? Math.min(1, Math.max(0.01, smoothing)) : 1;
    if (!isRenderableMotion(current) || factor >= 1) {
        return { motion: target, settled: true };
    }

    const opacity = current.opacity + ((target.opacity - current.opacity) * factor);
    const translateYPx = current.translateYPx + ((target.translateYPx - current.translateYPx) * factor);
    const widthPx = current.widthPx + ((target.widthPx - current.widthPx) * factor);
    const settled = (
        Math.abs(target.opacity - opacity) < SETTLE_EPSILON_OPACITY &&
        Math.abs(target.translateYPx - translateYPx) < SETTLE_EPSILON_PX &&
        Math.abs(target.widthPx - widthPx) < SETTLE_EPSILON_PX
    );

    return settled
        ? { motion: target, settled: true }
        : { motion: { opacity, translateYPx, widthPx }, settled: false };
}

function appendFocusWindow(
    indexes: Set<number>,
    params: Readonly<{
        focusIndex: number | null;
        markerCount: number;
        radius: number;
    }>,
): void {
    if (params.focusIndex === null) return;
    const start = Math.max(0, params.focusIndex - params.radius);
    const end = Math.min(params.markerCount - 1, params.focusIndex + params.radius);
    for (let index = start; index <= end; index += 1) {
        indexes.add(index);
    }
}

export function resolveTranscriptNavigationRailMotionUpdateIndexes(
    input: ResolveTranscriptNavigationRailMotionUpdateIndexesInput,
): readonly number[] {
    const markerCount = Number.isInteger(input.markerCount) && input.markerCount > 0 ? input.markerCount : 0;
    if (markerCount === 0) return [];
    const inputRadius = input.radius;
    const radius = typeof inputRadius === 'number' && Number.isInteger(inputRadius) && inputRadius >= 0
        ? inputRadius
        : FALLOFF_WINDOW_RADIUS;
    const indexes = new Set<number>();
    appendFocusWindow(indexes, {
        focusIndex: finiteIntegerOrNull(input.previousFocusIndex),
        markerCount,
        radius,
    });
    appendFocusWindow(indexes, {
        focusIndex: finiteIntegerOrNull(input.nextFocusIndex),
        markerCount,
        radius,
    });
    return [...indexes].sort((left, right) => left - right);
}
