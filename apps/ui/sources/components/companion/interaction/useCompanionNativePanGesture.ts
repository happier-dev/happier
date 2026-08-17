import * as React from 'react';
import type { ViewStyle } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';

import { COMPANION_DRAG_THRESHOLD_PX } from './companionPointerDragConfig';
import type { CompanionNoDragRegionRect } from './CompanionNoDragRegion';
import {
    projectCompanionRelease,
    resolveCompanionReleaseSpringConfig,
    type CompanionReleaseMotion,
} from './companionReleaseMotion';

export const COMPANION_NATIVE_PAN_DRAG_THRESHOLD_PT = COMPANION_DRAG_THRESHOLD_PX;

/** How long the "picked up" affordance takes to grow and to let go. */
const COMPANION_DRAG_LIFT_IN_MS = 120;
const COMPANION_DRAG_LIFT_OUT_MS = 180;

export type CompanionPoint = Readonly<{ x: number; y: number }>;

export type CompanionDragBounds = Readonly<{
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}>;

/** Whether lift and settle animate, or snap for a reduced-motion consumer. */
export type CompanionDragMotionPolicy = 'animate' | 'snap';

type NativePanEvent = Readonly<{
    x?: number;
    y?: number;
    absoluteX?: number;
    absoluteY?: number;
    translationX?: number;
    translationY?: number;
    velocityX?: number;
    velocityY?: number;
}>;

/**
 * Where a release lands. The default is "wherever the finger let go, clamped" — the pet's
 * behaviour. A companion that wants edge snapping (the Voice orb) supplies its own resolver and
 * reads `projected`, which already carries its own projection coefficient.
 *
 * Runs on the UI thread: it must be a worklet.
 */
export type CompanionReleaseTargetResolver = (input: Readonly<{
    released: CompanionPoint;
    projected: CompanionPoint;
    velocityX: number;
    velocityY: number;
    bounds: CompanionDragBounds;
}>) => CompanionPoint;

export type UseCompanionNativePanGestureResult<TDragState> = Readonly<{
    gesture: ReturnType<typeof Gesture.Pan>;
    animatedStyle: ReturnType<typeof useAnimatedStyle<ViewStyle>>;
    /** 0 at rest, 1 while the companion is held. Drives lift/scale without re-rendering. */
    dragProgress: ReturnType<typeof useSharedValue<number>>;
    /**
     * The live position, on the UI thread. Exposed because a companion that docks (the Voice orb
     * interpolating into its sheet) has to read where it currently is without a re-render.
     */
    translateX: ReturnType<typeof useSharedValue<number>>;
    translateY: ReturnType<typeof useSharedValue<number>>;
    dragState: TDragState | null;
    point: CompanionPoint;
    shouldSuppressPress: () => boolean;
}>;

export type UseCompanionNativePanGestureParams<TDragState> = Readonly<{
    bounds: CompanionDragBounds;
    initialPoint: CompanionPoint;
    noDragRegions: readonly CompanionNoDragRegionRect[];
    /**
     * The companion's own settle. Injected rather than baked in: the pet arrives with a clipped
     * overshoot, the Voice orb is critically damped and must not inherit that bounce.
     */
    releaseMotion: CompanionReleaseMotion;
    /** Defaults to the pet-compatible animated behavior. */
    motionPolicy?: CompanionDragMotionPolicy;
    resolveReleaseTarget?: CompanionReleaseTargetResolver;
    /** Horizontal drag distance → the companion's own drag state. Omitted when it has none. */
    resolveDragState?: (translationX: number) => TDragState | null;
    onDragStateChange?: (state: TDragState | null) => void;
    onPositionChange?: (payload: Readonly<{ point: CompanionPoint }>) => void;
    onDragRelease?: (payload: Readonly<{
        velocityX: number;
        velocityY: number;
        target: CompanionPoint;
    }>) => void;
}>;

function readFinite(value: number | undefined, fallback = 0): number {
    'worklet';
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampPoint(point: CompanionPoint, bounds: CompanionDragBounds): CompanionPoint {
    'worklet';
    return {
        x: Math.min(bounds.maxX, Math.max(bounds.minX, point.x)),
        y: Math.min(bounds.maxY, Math.max(bounds.minY, point.y)),
    };
}

function eventStartedInNoDragRegion(
    event: NativePanEvent,
    regions: readonly CompanionNoDragRegionRect[],
): boolean {
    'worklet';
    const x = readFinite(event.x, readFinite(event.absoluteX));
    const y = readFinite(event.y, readFinite(event.absoluteY));
    for (const region of regions) {
        if (
            x >= region.x
            && x <= region.x + region.width
            && y >= region.y
            && y <= region.y + region.height
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Native pan for a floating companion: 1:1 drag, bounds clamp, no-drag regions, and a release that
 * is entirely described by the caller's `releaseMotion` + `resolveReleaseTarget`.
 *
 * Everything companion-specific — the spring, the projection, the drag state vocabulary, and what
 * (if anything) is persisted — is supplied from outside. What remains here is the gesture session
 * itself, which is genuinely the same object-under-a-finger problem for every companion.
 */
export function useCompanionNativePanGesture<TDragState = never>(
    params: UseCompanionNativePanGestureParams<TDragState>,
): UseCompanionNativePanGestureResult<TDragState> {
    const translateX = useSharedValue(params.initialPoint.x);
    const translateY = useSharedValue(params.initialPoint.y);
    const startX = useSharedValue(params.initialPoint.x);
    const startY = useSharedValue(params.initialPoint.y);
    const ignored = useSharedValue(false);
    const moved = useSharedValue(false);
    const dragProgress = useSharedValue(0);
    const [point, setPoint] = React.useState<CompanionPoint>(params.initialPoint);
    const [dragState, setDragState] = React.useState<TDragState | null>(null);
    const suppressNextPressRef = React.useRef(false);

    React.useEffect(() => {
        translateX.value = params.initialPoint.x;
        translateY.value = params.initialPoint.y;
        startX.value = params.initialPoint.x;
        startY.value = params.initialPoint.y;
        setPoint(params.initialPoint);
    }, [
        params.initialPoint.x,
        params.initialPoint.y,
        startX,
        startY,
        translateX,
        translateY,
    ]);

    const publishPoint = React.useCallback((nextPoint: CompanionPoint) => {
        setPoint(nextPoint);
    }, []);

    const publishDragState = React.useCallback((nextState: TDragState | null) => {
        setDragState(nextState);
        params.onDragStateChange?.(nextState);
    }, [params]);

    const commitPosition = React.useCallback((nextPoint: CompanionPoint) => {
        params.onPositionChange?.({ point: nextPoint });
    }, [params]);

    const publishRelease = React.useCallback((
        velocityX: number,
        velocityY: number,
        target: CompanionPoint,
    ) => {
        params.onDragRelease?.({ velocityX, velocityY, target });
    }, [params]);

    const markSuppressNextPress = React.useCallback(() => {
        suppressNextPressRef.current = true;
    }, []);

    const releaseMotion = params.releaseMotion;
    const snapMotion = params.motionPolicy === 'snap';
    const resolveReleaseTarget = params.resolveReleaseTarget;
    const resolveDragState = params.resolveDragState;

    const gesture = React.useMemo(() => Gesture.Pan()
        .minDistance(COMPANION_NATIVE_PAN_DRAG_THRESHOLD_PT)
        .withTestId('companion-native-pan-gesture')
        .onBegin((event: NativePanEvent) => {
            ignored.value = eventStartedInNoDragRegion(event, params.noDragRegions);
            moved.value = false;
            startX.value = translateX.value;
            startY.value = translateY.value;
            if (!ignored.value) {
                dragProgress.value = snapMotion
                    ? 1
                    : withTiming(1, { duration: COMPANION_DRAG_LIFT_IN_MS });
            }
        })
        .onUpdate((event: NativePanEvent) => {
            if (ignored.value) return;

            const translationX = readFinite(event.translationX);
            const translationY = readFinite(event.translationY);
            const nextMoved =
                Math.abs(translationX) >= COMPANION_NATIVE_PAN_DRAG_THRESHOLD_PT
                || Math.abs(translationY) >= COMPANION_NATIVE_PAN_DRAG_THRESHOLD_PT;
            moved.value = moved.value || nextMoved;

            const nextPoint = clampPoint({
                x: startX.value + translationX,
                y: startY.value + translationY,
            }, params.bounds);
            translateX.value = nextPoint.x;
            translateY.value = nextPoint.y;
            runOnJS(publishPoint)(nextPoint);

            if (
                resolveDragState
                && Math.abs(translationX) >= COMPANION_NATIVE_PAN_DRAG_THRESHOLD_PT
            ) {
                const nextDragState = resolveDragState(translationX);
                if (nextDragState !== null) runOnJS(publishDragState)(nextDragState);
            }
        })
        .onEnd((event: NativePanEvent) => {
            if (ignored.value) return;

            const velocityX = readFinite(event.velocityX);
            const velocityY = readFinite(event.velocityY);
            const released = clampPoint({
                x: startX.value + readFinite(event.translationX),
                y: startY.value + readFinite(event.translationY),
            }, params.bounds);
            const projected = {
                x: projectCompanionRelease(released.x, velocityX, releaseMotion),
                y: projectCompanionRelease(released.y, velocityY, releaseMotion),
            };
            const target = resolveReleaseTarget
                ? resolveReleaseTarget({ released, projected, velocityX, velocityY, bounds: params.bounds })
                : released;
            translateX.value = snapMotion
                ? target.x
                : withSpring(
                    target.x,
                    resolveCompanionReleaseSpringConfig(releaseMotion, velocityX),
                );
            translateY.value = snapMotion
                ? target.y
                : withSpring(
                    target.y,
                    resolveCompanionReleaseSpringConfig(releaseMotion, velocityY),
                );
            runOnJS(publishPoint)(target);

            if (moved.value) {
                runOnJS(markSuppressNextPress)();
                runOnJS(commitPosition)(target);
                runOnJS(publishRelease)(velocityX, velocityY, target);
            }
        })
        .onFinalize(() => {
            ignored.value = false;
            moved.value = false;
            dragProgress.value = snapMotion
                ? 0
                : withTiming(0, { duration: COMPANION_DRAG_LIFT_OUT_MS });
            runOnJS(publishDragState)(null);
        }), [
            commitPosition,
            dragProgress,
            ignored,
            markSuppressNextPress,
            moved,
            params.bounds,
            params.noDragRegions,
            publishDragState,
            publishPoint,
            publishRelease,
            releaseMotion,
            resolveDragState,
            resolveReleaseTarget,
            snapMotion,
            startX,
            startY,
            translateX,
            translateY,
        ]);

    const animatedStyle = useAnimatedStyle(() => ({
        transform: [
            { translateX: translateX.value },
            { translateY: translateY.value },
        ],
    }));

    const shouldSuppressPress = React.useCallback(() => {
        if (!suppressNextPressRef.current) return false;
        suppressNextPressRef.current = false;
        return true;
    }, []);

    return {
        gesture,
        animatedStyle,
        dragProgress,
        translateX,
        translateY,
        dragState,
        point,
        shouldSuppressPress,
    };
}

export const CompanionNativeAnimatedView = Animated.View;
