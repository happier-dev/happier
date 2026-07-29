import * as React from 'react';
import type { ViewStyle } from 'react-native';
import {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';

import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

export const STAGE_CAMERA_MIN_SCALE = 1;
export const STAGE_CAMERA_MAX_SCALE = 2.25;

export type StageTargetRect = Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
}>;

export type StageCameraMode = 'camera' | 'crossfade';

export type StageCameraTransformInput = Readonly<{
    containerWidth: number;
    containerHeight: number;
    targetRect?: StageTargetRect | null;
    zoom?: number;
    reducedMotion: boolean;
}>;

export type StageCameraTransform = Readonly<{
    mode: StageCameraMode;
    scale: number;
    translateX: number;
    translateY: number;
}>;

export type UseStageTransformInput = Readonly<{
    frameId: string;
    containerWidth: number;
    containerHeight: number;
    targetRect?: StageTargetRect | null;
    zoom?: number;
    reducedMotion?: boolean;
    externallyDriven?: boolean;
    onCameraSettled?: (frameId: string) => void;
}>;

type StageAnimatedViewStyle = ReturnType<typeof useAnimatedStyle<ViewStyle>>;

export type StageTransformResult = Readonly<{
    mode: StageCameraMode;
    settledTransform: StageCameraTransform;
    motionDurationMs: number;
    outerAnimatedStyle: StageAnimatedViewStyle;
    innerAnimatedStyle: StageAnimatedViewStyle;
    incomingCrossfadeAnimatedStyle: StageAnimatedViewStyle;
    outgoingCrossfadeAnimatedStyle: StageAnimatedViewStyle;
}>;

export type StageCrossfadeFrameStyles = Readonly<{
    incoming: Readonly<{ opacity: number }>;
    outgoing: Readonly<{ opacity: number }>;
}>;

function clampScale(value: number): number {
    if (!Number.isFinite(value)) return STAGE_CAMERA_MIN_SCALE;
    return Math.min(STAGE_CAMERA_MAX_SCALE, Math.max(STAGE_CAMERA_MIN_SCALE, value));
}

function resolveTargetRect(containerWidth: number, containerHeight: number, targetRect?: StageTargetRect | null): StageTargetRect {
    if (
        targetRect
        && Number.isFinite(targetRect.x)
        && Number.isFinite(targetRect.y)
        && Number.isFinite(targetRect.width)
        && Number.isFinite(targetRect.height)
        && targetRect.width > 0
        && targetRect.height > 0
    ) {
        return targetRect;
    }

    return {
        x: 0,
        y: 0,
        width: Math.max(0, containerWidth),
        height: Math.max(0, containerHeight),
    };
}

export function resolveStageCameraTransform(input: StageCameraTransformInput): StageCameraTransform {
    if (input.reducedMotion) {
        return {
            mode: 'crossfade',
            scale: 1,
            translateX: 0,
            translateY: 0,
        };
    }

    const containerWidth = Math.max(0, input.containerWidth);
    const containerHeight = Math.max(0, input.containerHeight);
    const targetRect = resolveTargetRect(containerWidth, containerHeight, input.targetRect);
    const scale = clampScale(input.zoom ?? STAGE_CAMERA_MIN_SCALE);
    const targetCenterX = targetRect.x + targetRect.width / 2;
    const targetCenterY = targetRect.y + targetRect.height / 2;

    return {
        mode: 'camera',
        scale,
        translateX: scale * (containerWidth / 2 - targetCenterX),
        translateY: scale * (containerHeight / 2 - targetCenterY),
    };
}

export function resolveStageCameraDurationMs(transform: StageCameraTransform): number {
    if (transform.mode === 'crossfade') return reanimatedMotionTokens.durationMs.stageCrossfade;

    const travel = Math.abs(transform.translateX)
        + Math.abs(transform.translateY)
        + Math.abs(transform.scale - 1) * 320;
    if (travel <= 160) return 700;
    if (travel >= 960) return reanimatedMotionTokens.durationMs.stageCamera;
    return Math.round(700 + ((travel - 160) / 800) * 300);
}

export function clampProgress(value: number): number {
    'worklet';
    if (!Number.isFinite(value)) return 1;
    return Math.min(1, Math.max(0, value));
}

export function resolvePostCameraTargetRect(
    rect: StageTargetRect,
    transform: StageCameraTransform,
    transformBounds?: StageTargetRect,
): StageTargetRect {
    if (transform.mode === 'crossfade') return rect;
    const originX = transformBounds ? transformBounds.x + transformBounds.width / 2 : 0;
    const originY = transformBounds ? transformBounds.y + transformBounds.height / 2 : 0;
    return {
        x: originX + (rect.x - originX) * transform.scale + transform.translateX,
        y: originY + (rect.y - originY) * transform.scale + transform.translateY,
        width: rect.width * transform.scale,
        height: rect.height * transform.scale,
    };
}

export function resolveStageCrossfadeFrameStyles(progress: number): StageCrossfadeFrameStyles {
    'worklet';
    const normalizedProgress = clampProgress(progress);
    return {
        incoming: { opacity: normalizedProgress },
        outgoing: { opacity: 1 - normalizedProgress },
    };
}

export function useStageTransform(input: UseStageTransformInput): StageTransformResult {
    const preferredReducedMotion = useReducedMotionPreference();
    const reducedMotion = input.reducedMotion ?? preferredReducedMotion;
    const target = React.useMemo(() => resolveStageCameraTransform({
        containerWidth: input.containerWidth,
        containerHeight: input.containerHeight,
        targetRect: input.targetRect,
        zoom: input.zoom,
        reducedMotion,
    }), [
        input.containerWidth,
        input.containerHeight,
        input.targetRect,
        input.zoom,
        reducedMotion,
    ]);

    const translateX = useSharedValue(target.translateX);
    const translateY = useSharedValue(target.translateY);
    const scale = useSharedValue(target.scale);
    const crossfadeProgress = useSharedValue(1);
    const previousFrameIdRef = React.useRef(input.frameId);
    const motionDurationMs = resolveStageCameraDurationMs(target);

    React.useEffect(() => {
        if (input.externallyDriven) {
            translateX.value = target.translateX;
            translateY.value = target.translateY;
            scale.value = target.scale;
            crossfadeProgress.value = 1;
            previousFrameIdRef.current = input.frameId;
            return;
        }
        const cameraConfig = {
            duration: motionDurationMs,
            easing: reanimatedMotionTokens.easing.stageCamera,
        };
        const crossfadeConfig = {
            duration: reanimatedMotionTokens.durationMs.stageCrossfade,
            easing: reanimatedMotionTokens.easing.stageCamera,
        };

        const frameChanged = previousFrameIdRef.current !== input.frameId;
        previousFrameIdRef.current = input.frameId;

        translateX.value = withTiming(target.translateX, cameraConfig);
        translateY.value = withTiming(target.translateY, cameraConfig);
        scale.value = withTiming(target.scale, cameraConfig, (finished) => {
            if (finished && target.mode === 'camera' && input.onCameraSettled) {
                runOnJS(input.onCameraSettled)(input.frameId);
            }
        });

        if (target.mode === 'crossfade' && frameChanged) {
            crossfadeProgress.value = 0;
            crossfadeProgress.value = withTiming(1, crossfadeConfig);
        } else {
            crossfadeProgress.value = 1;
        }
    }, [
        input.frameId,
        input.onCameraSettled,
        input.externallyDriven,
        target,
        motionDurationMs,
        translateX,
        translateY,
        scale,
        crossfadeProgress,
    ]);

    const outerAnimatedStyle = useAnimatedStyle<ViewStyle>(() => ({
        transform: [
            { translateX: translateX.value },
            { translateY: translateY.value },
        ],
    }));
    const innerAnimatedStyle = useAnimatedStyle<ViewStyle>(() => ({
        transform: [{ scale: scale.value }],
    }));
    const incomingCrossfadeAnimatedStyle = useAnimatedStyle<ViewStyle>(() => (
        resolveStageCrossfadeFrameStyles(crossfadeProgress.value).incoming
    ));
    const outgoingCrossfadeAnimatedStyle = useAnimatedStyle<ViewStyle>(() => (
        resolveStageCrossfadeFrameStyles(crossfadeProgress.value).outgoing
    ));

    return {
        mode: target.mode,
        settledTransform: target,
        motionDurationMs,
        outerAnimatedStyle,
        innerAnimatedStyle,
        incomingCrossfadeAnimatedStyle,
        outgoingCrossfadeAnimatedStyle,
    };
}
