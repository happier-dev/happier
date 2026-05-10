import * as React from 'react';
import type { ViewStyle } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
} from 'react-native-reanimated';

import type { PetAnimationStateV1 } from '@happier-dev/protocol';

import {
    PET_POSITION_SPRING_DAMPING_FRACTION,
    PET_POSITION_SPRING_RESPONSE,
} from '@/components/pets/animation/petAnimationPlaybackConfig';
import type {
    PetCompanionPoint,
    PetCompanionPositionBounds,
} from '@/sync/domains/pets/companionPosition/companionPosition';
import { normalizePetCompanionPosition } from '@/sync/domains/pets/companionPosition/companionPosition';

import type { PetNoDragRegionRect } from './PetNoDragRegion';

export const PET_NATIVE_PAN_DRAG_THRESHOLD_PT = 4;

const PET_NATIVE_PAN_SPRING_CONFIG = Object.freeze({
    duration: PET_POSITION_SPRING_RESPONSE * 1000,
    dampingRatio: PET_POSITION_SPRING_DAMPING_FRACTION,
    overshootClamping: true,
});

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

export type UsePetNativePanGestureResult = Readonly<{
    gesture: ReturnType<typeof Gesture.Pan>;
    animatedStyle: ReturnType<typeof useAnimatedStyle<ViewStyle>>;
    dragState: PetAnimationStateV1 | null;
    point: PetCompanionPoint;
    shouldSuppressPress: () => boolean;
}>;

export type UsePetNativePanGestureParams = Readonly<{
    bounds: PetCompanionPositionBounds;
    initialPoint: PetCompanionPoint;
    noDragRegions: readonly PetNoDragRegionRect[];
    onDragStateChange?: (state: PetAnimationStateV1 | null) => void;
    onPositionChange?: (payload: Readonly<{
        point: PetCompanionPoint;
        normalized: Readonly<{ normalizedX: number; normalizedY: number }>;
    }>) => void;
    onDragRelease?: (payload: Readonly<{
        velocityX: number;
        velocityY: number;
    }>) => void;
}>;

function readFinite(value: number | undefined, fallback = 0): number {
    'worklet';
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampPoint(point: PetCompanionPoint, bounds: PetCompanionPositionBounds): PetCompanionPoint {
    'worklet';
    return {
        x: Math.min(bounds.maxX, Math.max(bounds.minX, point.x)),
        y: Math.min(bounds.maxY, Math.max(bounds.minY, point.y)),
    };
}

function eventStartedInNoDragRegion(event: NativePanEvent, regions: readonly PetNoDragRegionRect[]): boolean {
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

export function usePetNativePanGesture(params: UsePetNativePanGestureParams): UsePetNativePanGestureResult {
    const translateX = useSharedValue(params.initialPoint.x);
    const translateY = useSharedValue(params.initialPoint.y);
    const startX = useSharedValue(params.initialPoint.x);
    const startY = useSharedValue(params.initialPoint.y);
    const ignored = useSharedValue(false);
    const moved = useSharedValue(false);
    const [point, setPoint] = React.useState<PetCompanionPoint>(params.initialPoint);
    const [dragState, setDragState] = React.useState<PetAnimationStateV1 | null>(null);
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

    const publishPoint = React.useCallback((nextPoint: PetCompanionPoint) => {
        setPoint(nextPoint);
    }, []);

    const publishDragState = React.useCallback((nextState: PetAnimationStateV1 | null) => {
        setDragState(nextState);
        params.onDragStateChange?.(nextState);
    }, [params]);

    const commitPosition = React.useCallback((nextPoint: PetCompanionPoint) => {
        params.onPositionChange?.({
            point: nextPoint,
            normalized: normalizePetCompanionPosition(nextPoint, params.bounds),
        });
    }, [params]);

    const publishRelease = React.useCallback((velocityX: number, velocityY: number) => {
        params.onDragRelease?.({ velocityX, velocityY });
    }, [params]);

    const markSuppressNextPress = React.useCallback(() => {
        suppressNextPressRef.current = true;
    }, []);

    const gesture = React.useMemo(() => Gesture.Pan()
        .minDistance(PET_NATIVE_PAN_DRAG_THRESHOLD_PT)
        .withTestId('pet-native-pan-gesture')
        .onBegin((event: NativePanEvent) => {
            ignored.value = eventStartedInNoDragRegion(event, params.noDragRegions);
            moved.value = false;
            startX.value = translateX.value;
            startY.value = translateY.value;
        })
        .onUpdate((event: NativePanEvent) => {
            if (ignored.value) return;

            const translationX = readFinite(event.translationX);
            const translationY = readFinite(event.translationY);
            const nextMoved =
                Math.abs(translationX) >= PET_NATIVE_PAN_DRAG_THRESHOLD_PT
                || Math.abs(translationY) >= PET_NATIVE_PAN_DRAG_THRESHOLD_PT;
            moved.value = moved.value || nextMoved;

            const nextPoint = clampPoint({
                x: startX.value + translationX,
                y: startY.value + translationY,
            }, params.bounds);
            translateX.value = nextPoint.x;
            translateY.value = nextPoint.y;
            runOnJS(publishPoint)(nextPoint);

            if (Math.abs(translationX) >= PET_NATIVE_PAN_DRAG_THRESHOLD_PT) {
                runOnJS(publishDragState)(translationX >= 0 ? 'running-right' : 'running-left');
            }
        })
        .onEnd((event: NativePanEvent) => {
            if (ignored.value) return;

            const nextPoint = clampPoint({
                x: startX.value + readFinite(event.translationX),
                y: startY.value + readFinite(event.translationY),
            }, params.bounds);
            translateX.value = withSpring(nextPoint.x, PET_NATIVE_PAN_SPRING_CONFIG);
            translateY.value = withSpring(nextPoint.y, PET_NATIVE_PAN_SPRING_CONFIG);
            runOnJS(publishPoint)(nextPoint);

            if (moved.value) {
                runOnJS(markSuppressNextPress)();
                runOnJS(commitPosition)(nextPoint);
                runOnJS(publishRelease)(readFinite(event.velocityX), readFinite(event.velocityY));
            }
        })
        .onFinalize(() => {
            ignored.value = false;
            moved.value = false;
            runOnJS(publishDragState)(null);
        }), [
            commitPosition,
            ignored,
            markSuppressNextPress,
            moved,
            params.bounds,
            params.noDragRegions,
            publishDragState,
            publishPoint,
            publishRelease,
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
        dragState,
        point,
        shouldSuppressPress,
    };
}

export const PetNativeAnimatedView = Animated.View;
