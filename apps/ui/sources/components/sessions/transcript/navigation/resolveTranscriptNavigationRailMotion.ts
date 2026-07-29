import { Platform, type ViewStyle } from 'react-native';

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

const REST_WIDTH_PX = 3;
const FOCUS_WIDTH_PX = 16;
const REST_OPACITY = 0.28;
const VISIBLE_OPACITY_FLOOR = 0.56;
const ACTIVE_OPACITY_FLOOR = 0.9;
const FOCUS_OPACITY_FLOOR = 0.7;
const FALLOFF_SIGMA = 1.35;
// Markers past this distance resolve to EXACTLY the rest motion, so a focus
// change produces an identical motion value for every marker outside the window
// and the memoized markers skip re-rendering — the bounded update window is a
// property of the resolver, not of an imperative writer.
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

/**
 * The rail's easing lives in CSS on the marker's own stable class, so React stays
 * the single owner of every motion channel: it renders the resolved target and
 * the browser interpolates. Reduced motion collapses the duration to zero rather
 * than removing the declaration, so the same style path serves both preferences.
 * Native never renders the rail (`deriveTranscriptNavigationRailLayout` hides it
 * off web), so there is no setNativeProps counterpart to keep in sync.
 */
export function resolveTranscriptNavigationRailMarkerTransitionStyle(
    reducedMotion: boolean,
): ViewStyle | null {
    if (Platform.OS !== 'web') return null;
    // react-native-web supports transition* style props; cast at this web boundary.
    return {
        transitionProperty: 'width, opacity, transform, background-color',
        transitionDuration: reducedMotion ? '0ms' : '160ms',
        transitionTimingFunction: 'cubic-bezier(0.2, 0, 0, 1)',
    } as unknown as ViewStyle;
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
