import * as React from 'react';

import {
    resolvePostCameraTargetRect,
    type StageCameraTransform,
    type StageTargetRect,
} from './useStageTransform';

type StageWebCameraTransform = Pick<StageCameraTransform, 'translateX' | 'translateY' | 'scale'>;

export type StageWebCameraNode = Readonly<{
    style: {
        opacity: string;
        transform: string;
        willChange: string;
    };
}>;

export type StageWebHaloNode = Readonly<{
    style: {
        transform: string;
        transformOrigin: string;
        willChange: string;
    };
}>;

export type StageWebVisibilityNode = Readonly<{
    style: {
        opacity: string;
        willChange: string;
    };
}>;

export type StageWebCameraStep = Readonly<{
    transform: StageWebCameraTransform;
    settled: boolean;
}>;

export type StageWebCameraFrame = StageWebCameraStep & Readonly<{
    haloRect: StageTargetRect;
}>;

const CAMERA_TIME_CONSTANT_MS = 55;
const STALE_FRAME_GAP_MS = 250;
const CAMERA_RECOVERY_TIMEOUT_MS = 1_500;
const TRANSLATION_IDLE_EPSILON_PX = 0.05;
const SCALE_IDLE_EPSILON = 0.0001;

function isSettled(current: StageWebCameraTransform, target: StageWebCameraTransform): boolean {
    return Math.abs(current.translateX - target.translateX) <= TRANSLATION_IDLE_EPSILON_PX
        && Math.abs(current.translateY - target.translateY) <= TRANSLATION_IDLE_EPSILON_PX
        && Math.abs(current.scale - target.scale) <= SCALE_IDLE_EPSILON;
}

export function resolveStageWebCameraStep(
    current: StageWebCameraTransform,
    target: StageWebCameraTransform,
    elapsedMs: number,
): StageWebCameraStep {
    if (isSettled(current, target)) return { transform: target, settled: true };
    const normalizedElapsedMs = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
    if (normalizedElapsedMs >= STALE_FRAME_GAP_MS) {
        return { transform: target, settled: true };
    }
    const alpha = 1 - Math.exp(-normalizedElapsedMs / CAMERA_TIME_CONSTANT_MS);
    const transform = {
        translateX: current.translateX + (target.translateX - current.translateX) * alpha,
        translateY: current.translateY + (target.translateY - current.translateY) * alpha,
        scale: current.scale + (target.scale - current.scale) * alpha,
    };
    return isSettled(transform, target)
        ? { transform: target, settled: true }
        : { transform, settled: false };
}

export function resolveStageWebCameraFrame(params: Readonly<{
    current: StageWebCameraTransform;
    target: StageCameraTransform;
    elapsedMs: number;
    sourceTargetRect: StageTargetRect;
    transformBounds: StageTargetRect;
}>): StageWebCameraFrame {
    const cameraStep = resolveStageWebCameraStep(params.current, params.target, params.elapsedMs);
    return {
        ...cameraStep,
        haloRect: resolvePostCameraTargetRect(
            params.sourceTargetRect,
            { ...cameraStep.transform, mode: 'camera' },
            params.transformBounds,
        ),
    };
}

function writeHaloTransform(
    node: StageWebHaloNode | null | undefined,
    sourceRect: StageTargetRect,
    projectedRect: StageTargetRect,
    scale: number,
): void {
    if (!node?.style) return;
    node.style.willChange = 'transform';
    node.style.transformOrigin = '0 0';
    node.style.transform = [
        `translate3d(${(projectedRect.x - sourceRect.x).toFixed(2)}px, ${(projectedRect.y - sourceRect.y).toFixed(2)}px, 0)`,
        `scale(${scale.toFixed(4)})`,
    ].join(' ');
}

export function writeStageWebMotionVisibility(
    liveNode: StageWebVisibilityNode | null | undefined,
    frozenNode: StageWebVisibilityNode | null | undefined,
    moving: boolean,
): void {
    if (liveNode?.style) {
        liveNode.style.willChange = 'opacity';
        liveNode.style.opacity = moving ? '0' : '1';
    }
    if (frozenNode?.style) {
        frozenNode.style.willChange = 'transform, opacity';
        frozenNode.style.opacity = moving ? '1' : '0';
    }
}

function writeCameraTransform(
    outerNode: StageWebCameraNode | null,
    innerNode: StageWebCameraNode | null,
    transform: StageWebCameraTransform,
    additionalOuterNode?: StageWebCameraNode | null,
    additionalInnerNode?: StageWebCameraNode | null,
    haloNode?: StageWebHaloNode | null,
    haloSourceRect?: StageTargetRect | null,
    haloRect?: StageTargetRect,
    cameraNodeTranslationScale = 1,
): void {
    for (const node of [outerNode, additionalOuterNode]) {
        if (!node) continue;
        node.style.willChange = 'transform';
        node.style.transform = `translate3d(${(transform.translateX * cameraNodeTranslationScale).toFixed(2)}px, ${(transform.translateY * cameraNodeTranslationScale).toFixed(2)}px, 0)`;
    }
    for (const node of [innerNode, additionalInnerNode]) {
        if (!node) continue;
        node.style.willChange = 'transform';
        node.style.transform = `scale(${transform.scale.toFixed(4)})`;
    }
    if (haloSourceRect && haloRect) {
        writeHaloTransform(haloNode, haloSourceRect, haloRect, transform.scale);
    }
}

export function useStageWebCamera(params: Readonly<{
    enabled: boolean;
    frameId: string;
    target: StageCameraTransform;
    outerRef: React.RefObject<StageWebCameraNode | null>;
    innerRef: React.RefObject<StageWebCameraNode | null>;
    additionalOuterRef?: React.RefObject<StageWebCameraNode | null>;
    additionalInnerRef?: React.RefObject<StageWebCameraNode | null>;
    haloRef?: React.RefObject<StageWebHaloNode | null>;
    haloSourceRect?: StageTargetRect | null;
    transformBounds: StageTargetRect;
    freezeDuringMotion: boolean;
    liveLayerRef?: React.RefObject<StageWebVisibilityNode | null>;
    frozenLayerRef?: React.RefObject<StageWebVisibilityNode | null>;
    cameraNodeTranslationScale: number;
    onMotionChange: (moving: boolean) => void;
    onSettled: (frameId: string) => void;
}>): void {
    const currentRef = React.useRef<StageWebCameraTransform | null>(null);
    const onMotionChangeRef = React.useRef(params.onMotionChange);
    const onSettledRef = React.useRef(params.onSettled);
    onMotionChangeRef.current = params.onMotionChange;
    onSettledRef.current = params.onSettled;

    React.useLayoutEffect(() => {
        if (!params.enabled || !params.freezeDuringMotion) return;
        writeStageWebMotionVisibility(
            params.liveLayerRef?.current,
            params.frozenLayerRef?.current,
            false,
        );
    }, [
        params.enabled,
        params.freezeDuringMotion,
        params.frozenLayerRef,
        params.liveLayerRef,
    ]);

    React.useLayoutEffect(() => {
        if (!params.enabled) {
            currentRef.current = params.target;
            return undefined;
        }

        if (!currentRef.current) {
            currentRef.current = params.target;
            const haloRect = params.haloSourceRect
                ? resolvePostCameraTargetRect(params.haloSourceRect, params.target, params.transformBounds)
                : undefined;
            writeCameraTransform(
                params.outerRef.current,
                params.innerRef.current,
                params.target,
                params.additionalOuterRef?.current,
                params.additionalInnerRef?.current,
                params.haloRef?.current,
                params.haloSourceRect,
                haloRect,
                params.cameraNodeTranslationScale,
            );
            return undefined;
        }

        if (isSettled(currentRef.current, params.target)) {
            currentRef.current = params.target;
            const haloRect = params.haloSourceRect
                ? resolvePostCameraTargetRect(params.haloSourceRect, params.target, params.transformBounds)
                : undefined;
            writeCameraTransform(
                params.outerRef.current,
                params.innerRef.current,
                params.target,
                params.additionalOuterRef?.current,
                params.additionalInnerRef?.current,
                params.haloRef?.current,
                params.haloSourceRect,
                haloRect,
                params.cameraNodeTranslationScale,
            );
            if (params.freezeDuringMotion) {
                writeStageWebMotionVisibility(
                    params.liveLayerRef?.current,
                    params.frozenLayerRef?.current,
                    false,
                );
            }
            return undefined;
        }

        let cancelled = false;
        let completed = false;
        let animationFrame = 0;
        let recoveryTimeout: ReturnType<typeof setTimeout> | null = null;
        let previousAt = performance.now();
        if (params.freezeDuringMotion) {
            writeStageWebMotionVisibility(
                params.liveLayerRef?.current,
                params.frozenLayerRef?.current,
                true,
            );
        }
        onMotionChangeRef.current(true);

        const finishMotion = () => {
            if (cancelled || completed) return;
            completed = true;
            if (recoveryTimeout) {
                clearTimeout(recoveryTimeout);
                recoveryTimeout = null;
            }
            currentRef.current = params.target;
            const haloRect = params.haloSourceRect
                ? resolvePostCameraTargetRect(params.haloSourceRect, params.target, params.transformBounds)
                : undefined;
            writeCameraTransform(
                params.outerRef.current,
                params.innerRef.current,
                params.target,
                params.additionalOuterRef?.current,
                params.additionalInnerRef?.current,
                params.haloRef?.current,
                params.haloSourceRect,
                haloRect,
                params.cameraNodeTranslationScale,
            );
            if (params.freezeDuringMotion) {
                writeStageWebMotionVisibility(
                    params.liveLayerRef?.current,
                    params.frozenLayerRef?.current,
                    false,
                );
            }
            onMotionChangeRef.current(false);
            onSettledRef.current(params.frameId);
            cancelAnimationFrame(animationFrame);
        };
        recoveryTimeout = setTimeout(finishMotion, CAMERA_RECOVERY_TIMEOUT_MS);

        const tick = (at: number) => {
            if (cancelled || completed || !currentRef.current) return;
            let step: StageWebCameraStep;
            let haloRect: StageTargetRect | undefined;
            if (params.haloSourceRect) {
                const frame = resolveStageWebCameraFrame({
                    current: currentRef.current,
                    target: params.target,
                    elapsedMs: at - previousAt,
                    sourceTargetRect: params.haloSourceRect,
                    transformBounds: params.transformBounds,
                });
                step = frame;
                haloRect = frame.haloRect;
            } else {
                step = resolveStageWebCameraStep(currentRef.current, params.target, at - previousAt);
            }
            previousAt = at;
            currentRef.current = step.transform;
            writeCameraTransform(
                params.outerRef.current,
                params.innerRef.current,
                step.transform,
                params.additionalOuterRef?.current,
                params.additionalInnerRef?.current,
                params.haloRef?.current,
                params.haloSourceRect,
                haloRect,
                params.cameraNodeTranslationScale,
            );
            if (step.settled) {
                finishMotion();
                return;
            }
            animationFrame = requestAnimationFrame(tick);
        };
        animationFrame = requestAnimationFrame(tick);

        return () => {
            cancelled = true;
            if (recoveryTimeout) clearTimeout(recoveryTimeout);
            cancelAnimationFrame(animationFrame);
            if (!completed) {
                if (params.freezeDuringMotion) {
                    writeStageWebMotionVisibility(
                        params.liveLayerRef?.current,
                        params.frozenLayerRef?.current,
                        false,
                    );
                }
                onMotionChangeRef.current(false);
            }
        };
    }, [
        params.enabled,
        params.frameId,
        params.additionalInnerRef,
        params.additionalOuterRef,
        params.haloRef,
        params.innerRef,
        params.liveLayerRef,
        params.frozenLayerRef,
        params.freezeDuringMotion,
        params.cameraNodeTranslationScale,
        params.outerRef,
        params.target.scale,
        params.target.translateX,
        params.target.translateY,
        params.haloSourceRect?.x,
        params.haloSourceRect?.y,
        params.haloSourceRect?.width,
        params.haloSourceRect?.height,
        params.transformBounds.x,
        params.transformBounds.y,
        params.transformBounds.width,
        params.transformBounds.height,
    ]);
}
