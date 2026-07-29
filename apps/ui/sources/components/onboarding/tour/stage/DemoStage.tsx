import * as React from 'react';
import { Image, type LayoutChangeEvent, Platform, StyleSheet, View } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';

import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';

import {
    DeviceFrame,
    resolveDeviceFrameViewportGeometry,
    STAGE_DEVICE_CANVASES,
} from './DeviceFrame';
import {
    captureStageFrame,
    releaseStageFrame,
    type StageFrozenCapture,
} from './captureStageFrame';
import { Spotlight } from './Spotlight';
import type { StageFrame } from './stageFrames';
import { stageSurfaceById } from './stageSurfaces';
import {
    useRegisteredSpotlightTargetRect,
    useReadVisualSpotlightTargetRect,
    useRemeasureSpotlightTarget,
    SpotlightProvider,
    SpotlightTargetScope,
    type SpotlightTargetRef,
} from './useSpotlightTarget';
import { type StageTargetRect, useStageTransform } from './useStageTransform';
import {
    type StageWebCameraNode,
    type StageWebHaloNode,
    type StageWebVisibilityNode,
    useStageWebCamera,
} from './useStageWebCamera';

export const STAGE_SURFACE_MATERIALIZE_FADE_MS = reanimatedMotionTokens.durationMs.fast;
const STAGE_FROZEN_CAPTURE_MAX_AGE_MS = 15_000;

function MaterializedStageSurface(props: React.PropsWithChildren<Readonly<{
    reducedMotion: boolean;
    testID: string;
}>>): React.ReactElement {
    const opacity = useSharedValue(props.reducedMotion ? 1 : 0);
    React.useEffect(() => {
        opacity.value = props.reducedMotion
            ? 1
            : withTiming(1, {
                duration: STAGE_SURFACE_MATERIALIZE_FADE_MS,
                easing: reanimatedMotionTokens.easing.standard,
            });
    }, [opacity, props.reducedMotion]);
    const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

    return (
        <Animated.View testID={props.testID} style={[styles.surfaceSlot, animatedStyle]}>
            {props.children}
        </Animated.View>
    );
}

export type DemoStageProps = Readonly<{
    frames: readonly StageFrame[];
    activeFrameId: string;
    reducedMotion?: boolean;
}>;

type StageSize = Readonly<{
    width: number;
    height: number;
}>;

export function resolveMountedStageFrames(
    frames: readonly StageFrame[],
    activeFrameId: string,
): readonly StageFrame[] {
    if (frames.length === 0) return [];
    const activeIndex = Math.max(0, frames.findIndex((frame) => frame.id === activeFrameId));
    const startIndex = Math.max(0, activeIndex - 1);
    const endIndex = Math.min(frames.length - 1, activeIndex + 1);
    return frames.slice(startIndex, endIndex + 1);
}

function resolveActiveFrame(frames: readonly StageFrame[], activeFrameId: string): StageFrame | null {
    if (frames.length === 0) return null;
    return frames.find((frame) => frame.id === activeFrameId) ?? frames[0] ?? null;
}

function StageSurfaceSlot(props: Readonly<{
    frame: StageFrame;
    visible: boolean;
    spotlightTargetsActive?: boolean;
    style?: object;
    testID?: string;
    surfaceRef?: React.Ref<View>;
    reducedMotion: boolean;
}>): React.ReactElement | null {
    const surface = stageSurfaceById.get(props.frame.surface);
    if (!surface) return null;
    const Surface = surface.component;
    const testID = props.testID ?? `demo-stage-frame-${props.frame.id}`;
    const content = (
        <SpotlightTargetScope active={props.spotlightTargetsActive === true}>
            <React.Suspense fallback={(
                <View testID={`${testID}-loading`} style={styles.surfaceSlot} />
            )}>
                <MaterializedStageSurface
                    testID={`${testID}-content`}
                    reducedMotion={props.reducedMotion}
                >
                    <Surface device={props.frame.device} />
                </MaterializedStageSurface>
            </React.Suspense>
        </SpotlightTargetScope>
    );

    return (
        <Animated.View
            testID={testID}
            pointerEvents="none"
            style={[
                styles.surfaceSlot,
                props.visible ? styles.activeSlot : styles.warmSlot,
                props.style,
            ]}
        >
            {props.surfaceRef ? (
                <View
                    ref={props.surfaceRef}
                    collapsable={false}
                    testID={`demo-stage-surface-${props.frame.surface}-capture-source`}
                    style={styles.surfaceSlot}
                >
                    {content}
                </View>
            ) : content}
        </Animated.View>
    );
}

function FrozenStageFrame(props: Readonly<{ capture: StageFrozenCapture }>): React.ReactElement {
    return (
        <Image
            testID="demo-stage-camera-frozen-frame"
            source={{ uri: props.capture.uri }}
            resizeMode="stretch"
            style={styles.frozenFrame}
        />
    );
}

function DemoStageContent(props: DemoStageProps & Readonly<{
    activeFrame: StageFrame;
    mountedFrames: readonly StageFrame[];
    stageNodeRef: React.Ref<View>;
}>): React.ReactElement {
    const [stageSize, setStageSize] = React.useState<StageSize>(() => {
        const canvas = STAGE_DEVICE_CANVASES[props.activeFrame.device];
        return { width: canvas.width, height: canvas.height };
    });
    const fallbackRect = React.useMemo(() => ({
        x: 0,
        y: 0,
        width: stageSize.width,
        height: stageSize.height,
    }), [stageSize.height, stageSize.width]);
    const cameraViewport = React.useMemo(() => resolveDeviceFrameViewportGeometry(
        props.activeFrame.device,
        stageSize.width,
        stageSize.height,
    ), [props.activeFrame.device, stageSize.height, stageSize.width]);
    const spotlightTarget = useRegisteredSpotlightTargetRect(props.activeFrame.spotlight, fallbackRect);
    const cameraTargetRect = React.useMemo(() => (
        spotlightTarget.found
            ? {
                x: spotlightTarget.rect.x - cameraViewport.x,
                y: spotlightTarget.rect.y - cameraViewport.y,
                width: spotlightTarget.rect.width,
                height: spotlightTarget.rect.height,
            }
            : {
                x: 0,
                y: 0,
                width: cameraViewport.width,
                height: cameraViewport.height,
            }
    ), [
        cameraViewport.height,
        cameraViewport.width,
        cameraViewport.x,
        cameraViewport.y,
        spotlightTarget.found,
        spotlightTarget.rect,
    ]);
    const cameraTransformBounds = React.useMemo(() => ({
        x: cameraViewport.x,
        y: cameraViewport.y,
        width: cameraViewport.width,
        height: cameraViewport.height,
    }), [cameraViewport.height, cameraViewport.width, cameraViewport.x, cameraViewport.y]);
    const readVisualSpotlightTargetRect = useReadVisualSpotlightTargetRect(props.activeFrame.spotlight);
    const remeasureSpotlightTarget = useRemeasureSpotlightTarget(props.activeFrame.spotlight);
    const [settledSpotlightRect, setSettledSpotlightRect] = React.useState<StageTargetRect | null>(null);
    const [cameraFrozen, setCameraFrozen] = React.useState(false);
    const cameraFrozenRef = React.useRef(false);
    const thawTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const handleCameraSettled = React.useCallback((frameId: string) => {
        if (frameId !== props.activeFrame.id) return;
        if (thawTimeoutRef.current) {
            clearTimeout(thawTimeoutRef.current);
            thawTimeoutRef.current = null;
        }
        cameraFrozenRef.current = false;
        if (Platform.OS !== 'web') setCameraFrozen(false);
    }, [props.activeFrame.id]);
    const transform = useStageTransform({
        frameId: props.activeFrame.id,
        containerWidth: cameraViewport.width,
        containerHeight: cameraViewport.height,
        targetRect: cameraTargetRect,
        zoom: props.activeFrame.spotlight && !spotlightTarget.found
            ? 1
            : props.activeFrame.zoom,
        reducedMotion: props.reducedMotion,
        externallyDriven: Platform.OS === 'web',
        onCameraSettled: Platform.OS === 'web' ? undefined : handleCameraSettled,
    });
    const [outgoingFrame, setOutgoingFrame] = React.useState<StageFrame | null>(null);
    const previousActiveFrameRef = React.useRef(props.activeFrame);
    const previousCameraFrameRef = React.useRef(props.activeFrame);
    const webCameraOuterRef = React.useRef<StageWebCameraNode | null>(null);
    const webCameraInnerRef = React.useRef<StageWebCameraNode | null>(null);
    const webFrozenCameraOuterRef = React.useRef<StageWebCameraNode | null>(null);
    const webFrozenCameraInnerRef = React.useRef<StageWebCameraNode | null>(null);
    const webHaloRef = React.useRef<StageWebHaloNode | null>(null);
    const webLiveLayerRef = React.useRef<StageWebVisibilityNode | null>(null);
    const activeFrameRef = React.useRef(props.activeFrame);
    activeFrameRef.current = props.activeFrame;
    const liveSurfaceRef = React.useRef<View | null>(null);
    const snapshotRef = React.useRef<Readonly<{
        surfaceId: StageFrame['surface'];
        revision: number;
        capturedAtMs: number;
        capture: StageFrozenCapture;
    }> | null>(null);
    const captureGenerationRef = React.useRef(0);
    const captureInFlightRef = React.useRef(false);
    const captureLiveSurfaceRef = React.useRef<(() => Promise<void>) | null>(null);
    const mutationObserverActiveRef = React.useRef(false);
    const quietCaptureReadyRef = React.useRef(false);
    const surfaceMutationTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const surfaceRevisionRef = React.useRef(0);
    const [renderedSnapshot, setRenderedSnapshot] = React.useState<StageFrozenCapture | null>(null);
    const webCameraEnabled = Platform.OS === 'web' && transform.mode === 'camera';
    const snapshotFresh = Boolean(
        renderedSnapshot
        && snapshotRef.current
        && Date.now() - snapshotRef.current.capturedAtMs <= STAGE_FROZEN_CAPTURE_MAX_AGE_MS
    );

    useStageWebCamera({
        enabled: webCameraEnabled,
        frameId: props.activeFrame.id,
        target: transform.settledTransform,
        outerRef: webCameraOuterRef,
        innerRef: webCameraInnerRef,
        additionalOuterRef: webFrozenCameraOuterRef,
        additionalInnerRef: webFrozenCameraInnerRef,
        haloRef: webHaloRef,
        haloSourceRect: props.activeFrame.spotlight && spotlightTarget.found
            ? spotlightTarget.rect
            : null,
        transformBounds: cameraTransformBounds,
        cameraNodeTranslationScale: cameraViewport.scale > 0 ? 1 / cameraViewport.scale : 1,
        freezeDuringMotion: snapshotFresh,
        liveLayerRef: webLiveLayerRef,
        frozenLayerRef: webFrozenCameraOuterRef,
        onMotionChange: (moving) => {
            cameraFrozenRef.current = moving;
            if (!moving) {
                queueMicrotask(() => {
                    void captureLiveSurfaceRef.current?.();
                });
            }
        },
        onSettled: handleCameraSettled,
    });

    const releaseSnapshot = React.useCallback((capture: StageFrozenCapture) => {
        releaseStageFrame(capture);
    }, []);

    const captureLiveSurface = React.useCallback(async () => {
        if (captureInFlightRef.current || cameraFrozenRef.current) return;
        const node = liveSurfaceRef.current;
        const surfaceId = activeFrameRef.current.surface;
        const revision = surfaceRevisionRef.current;
        const captureSourceTestID = `demo-stage-surface-${surfaceId}-capture-source`;
        const existingSnapshot = snapshotRef.current;
        if (
            existingSnapshot?.surfaceId === surfaceId
            && existingSnapshot.revision === revision
            && Date.now() - existingSnapshot.capturedAtMs <= STAGE_FROZEN_CAPTURE_MAX_AGE_MS
        ) return;
        const generation = captureGenerationRef.current + 1;
        captureGenerationRef.current = generation;
        captureInFlightRef.current = true;
        try {
            const capture = await captureStageFrame(node, captureSourceTestID);
            if (
                captureGenerationRef.current !== generation
                || cameraFrozenRef.current
                || activeFrameRef.current.surface !== surfaceId
            ) {
                releaseSnapshot(capture);
                return;
            }
            const previousSnapshot = snapshotRef.current;
            snapshotRef.current = {
                surfaceId,
                revision,
                capturedAtMs: Date.now(),
                capture,
            };
            setRenderedSnapshot(capture);
            if (previousSnapshot && previousSnapshot.capture !== capture) {
                releaseSnapshot(previousSnapshot.capture);
            }
        } catch {
            // A failed system-boundary capture leaves the live camera path visible.
        } finally {
            captureInFlightRef.current = false;
            if (!cameraFrozenRef.current && quietCaptureReadyRef.current) {
                quietCaptureReadyRef.current = false;
                queueMicrotask(() => {
                    void captureLiveSurfaceRef.current?.();
                });
            }
        }
    }, [releaseSnapshot]);
    captureLiveSurfaceRef.current = captureLiveSurface;

    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
        setStageSize((current) => (
            current.width === width && current.height === height
                ? current
                : { width, height }
        ));
        remeasureSpotlightTarget();
    }, [remeasureSpotlightTarget]);

    React.useLayoutEffect(() => {
        const previousActiveFrame = previousActiveFrameRef.current;
        if (
            props.reducedMotion
            && previousActiveFrame.id !== props.activeFrame.id
            && previousActiveFrame.surface !== props.activeFrame.surface
        ) {
            setOutgoingFrame(previousActiveFrame);
        } else {
            setOutgoingFrame(null);
        }
        previousActiveFrameRef.current = props.activeFrame;
    }, [props.activeFrame, props.reducedMotion]);

    React.useLayoutEffect(() => {
        const previousFrame = previousCameraFrameRef.current;
        const frameChanged = previousFrame.id !== props.activeFrame.id;
        previousCameraFrameRef.current = props.activeFrame;

        if (frameChanged) {
            if (!mutationObserverActiveRef.current) {
                surfaceRevisionRef.current += 1;
                quietCaptureReadyRef.current = true;
            }
            setSettledSpotlightRect(null);
        }

        if (thawTimeoutRef.current) {
            clearTimeout(thawTimeoutRef.current);
            thawTimeoutRef.current = null;
        }
        if (Platform.OS === 'web') return;
        if (!frameChanged || transform.mode !== 'camera') {
            setCameraFrozen(false);
            return;
        }

        const snapshot = snapshotRef.current;
        if (
            !snapshot
            || snapshot.surfaceId !== previousFrame.surface
        ) {
            setCameraFrozen(false);
            return;
        }

        setCameraFrozen(true);
        thawTimeoutRef.current = setTimeout(() => {
            thawTimeoutRef.current = null;
            setCameraFrozen(false);
        }, transform.motionDurationMs + 150);
    }, [props.activeFrame, transform.mode, transform.motionDurationMs]);

    React.useLayoutEffect(() => {
        if (
            Platform.OS === 'web'
            || cameraFrozenRef.current
            || cameraFrozen
            || !props.activeFrame.spotlight
            || !spotlightTarget.found
        ) return;
        const frameId = props.activeFrame.id;
        readVisualSpotlightTargetRect((rect) => {
            if (previousCameraFrameRef.current.id !== frameId) return;
            setSettledSpotlightRect((current) => (
                current
                && current.x === rect.x
                && current.y === rect.y
                && current.width === rect.width
                && current.height === rect.height
                    ? current
                    : rect
            ));
        });
    }, [
        cameraFrozen,
        props.activeFrame.id,
        props.activeFrame.spotlight,
        readVisualSpotlightTargetRect,
        spotlightTarget.found,
        spotlightTarget.rect,
    ]);

    React.useEffect(() => {
        if (cameraFrozen || cameraFrozenRef.current) return;
        if (mutationObserverActiveRef.current && !quietCaptureReadyRef.current) return;
        quietCaptureReadyRef.current = false;
        void captureLiveSurface();
    }, [cameraFrozen, captureLiveSurface]);

    React.useEffect(() => {
        const node = liveSurfaceRef.current;
        if (!node || typeof MutationObserver !== 'function') return undefined;
        const observer = new MutationObserver(() => {
            surfaceRevisionRef.current += 1;
            quietCaptureReadyRef.current = false;
            if (surfaceMutationTimeoutRef.current) clearTimeout(surfaceMutationTimeoutRef.current);
            surfaceMutationTimeoutRef.current = setTimeout(() => {
                surfaceMutationTimeoutRef.current = null;
                quietCaptureReadyRef.current = true;
                if (cameraFrozenRef.current || captureInFlightRef.current) return;
                quietCaptureReadyRef.current = false;
                void captureLiveSurfaceRef.current?.();
            }, 3000);
        });
        try {
            observer.observe(node as unknown as Node, {
                attributes: true,
                characterData: true,
                childList: true,
                subtree: true,
            });
            mutationObserverActiveRef.current = true;
        } catch {
            observer.disconnect();
            return undefined;
        }
        return () => {
            mutationObserverActiveRef.current = false;
            if (surfaceMutationTimeoutRef.current) {
                clearTimeout(surfaceMutationTimeoutRef.current);
                surfaceMutationTimeoutRef.current = null;
            }
            observer.disconnect();
        };
    }, [props.activeFrame.surface]);

    React.useEffect(() => () => {
        captureGenerationRef.current += 1;
        if (thawTimeoutRef.current) {
            clearTimeout(thawTimeoutRef.current);
            thawTimeoutRef.current = null;
        }
        const snapshot = snapshotRef.current;
        snapshotRef.current = null;
        if (snapshot) releaseSnapshot(snapshot.capture);
    }, [releaseSnapshot]);

    React.useEffect(() => {
        if (!outgoingFrame) return undefined;
        const timeout = setTimeout(() => {
            setOutgoingFrame(null);
        }, reanimatedMotionTokens.durationMs.stageCrossfade);
        return () => {
            clearTimeout(timeout);
        };
    }, [outgoingFrame]);

    const visibleOutgoingFrame = transform.mode === 'crossfade' ? outgoingFrame : null;
    const warmFrames = props.mountedFrames.filter((frame) => (
        frame.id !== props.activeFrame.id
        && frame.id !== visibleOutgoingFrame?.id
        && frame.surface !== props.activeFrame.surface
        && frame.surface !== visibleOutgoingFrame?.surface
    ));

    return (
        <View ref={props.stageNodeRef} testID="demo-stage" onLayout={handleLayout} style={styles.root}>
            <DeviceFrame
                device={props.activeFrame.device}
                onViewportGeometryChange={remeasureSpotlightTarget}
                testID="demo-stage-device-frame"
            >
                <View
                    ref={webLiveLayerRef as React.Ref<never>}
                    testID="demo-stage-camera-live"
                    style={[
                        styles.cameraLayer,
                        cameraFrozen ? styles.hiddenCamera : styles.visibleCamera,
                    ]}
                >
                    <Animated.View
                        ref={webCameraOuterRef as React.Ref<never>}
                        testID="demo-stage-camera-outer"
                        style={[styles.cameraLayer, webCameraEnabled ? undefined : transform.outerAnimatedStyle]}
                    >
                        <Animated.View
                            ref={webCameraInnerRef as React.Ref<never>}
                            testID="demo-stage-camera-inner"
                            style={[styles.cameraLayer, webCameraEnabled ? undefined : transform.innerAnimatedStyle]}
                        >
                            {visibleOutgoingFrame ? (
                                <StageSurfaceSlot
                                    frame={visibleOutgoingFrame}
                                    visible
                                    reducedMotion
                                    testID={`demo-stage-crossfade-outgoing-${visibleOutgoingFrame.id}`}
                                    style={transform.outgoingCrossfadeAnimatedStyle}
                                />
                            ) : null}
                            <StageSurfaceSlot
                                frame={props.activeFrame}
                                visible
                                spotlightTargetsActive
                                surfaceRef={liveSurfaceRef}
                                reducedMotion={transform.mode === 'crossfade'}
                                style={transform.mode === 'crossfade' ? transform.incomingCrossfadeAnimatedStyle : undefined}
                            />
                        </Animated.View>
                    </Animated.View>
                </View>
                {renderedSnapshot ? (
                    <Animated.View
                        ref={webFrozenCameraOuterRef as React.Ref<never>}
                        testID="demo-stage-camera-frozen-outer"
                        style={[
                            styles.cameraLayer,
                            { opacity: webCameraEnabled ? 0 : cameraFrozen ? 1 : 0 },
                            webCameraEnabled ? undefined : transform.outerAnimatedStyle,
                        ]}
                    >
                        <Animated.View
                            ref={webFrozenCameraInnerRef as React.Ref<never>}
                            testID="demo-stage-camera-frozen-inner"
                            style={[styles.cameraLayer, webCameraEnabled ? undefined : transform.innerAnimatedStyle]}
                        >
                            <FrozenStageFrame capture={renderedSnapshot} />
                        </Animated.View>
                    </Animated.View>
                ) : null}
            </DeviceFrame>
            <Spotlight
                targetId={props.activeFrame.spotlight}
                fallbackRect={fallbackRect}
                dim={props.activeFrame.dim}
                settledCameraTransform={transform.settledTransform}
                settledTargetRect={settledSpotlightRect}
                externallyDriven={webCameraEnabled}
                haloRef={webHaloRef}
                testID="demo-stage-spotlight"
            />
            <View testID="demo-stage-warm-cache" pointerEvents="none" style={styles.warmCache}>
                {warmFrames.map((frame) => (
                    <StageSurfaceSlot
                        key={frame.id}
                        frame={frame}
                        visible={false}
                        reducedMotion={transform.mode === 'crossfade'}
                    />
                ))}
            </View>
        </View>
    );
}

export function DemoStage(props: DemoStageProps): React.ReactElement | null {
    const stageRef = React.useRef<SpotlightTargetRef | null>(null);
    const stageNodeRef = React.useCallback((node: View | null) => {
        stageRef.current = node;
    }, []);
    const activeFrame = resolveActiveFrame(props.frames, props.activeFrameId);
    if (!activeFrame) return null;
    const mountedFrames = resolveMountedStageFrames(props.frames, props.activeFrameId);

    return (
        <SpotlightProvider activeTargetId={activeFrame.spotlight ?? null} stageRef={stageRef}>
            <DemoStageContent
                frames={props.frames}
                activeFrameId={props.activeFrameId}
                reducedMotion={props.reducedMotion}
                activeFrame={activeFrame}
                mountedFrames={mountedFrames}
                stageNodeRef={stageNodeRef}
            />
        </SpotlightProvider>
    );
}

const styles = StyleSheet.create({
    root: {
        alignItems: 'stretch',
        flex: 1,
        justifyContent: 'flex-start',
        minHeight: 0,
        minWidth: 0,
    },
    cameraLayer: {
        ...StyleSheet.absoluteFillObject,
    },
    visibleCamera: {
        display: 'flex',
    },
    hiddenCamera: {
        display: 'none',
    },
    frozenFrame: {
        ...StyleSheet.absoluteFillObject,
        height: '100%',
        width: '100%',
    },
    surfaceSlot: {
        ...StyleSheet.absoluteFillObject,
    },
    activeSlot: {
        opacity: 1,
    },
    warmSlot: {
        opacity: 0,
    },
    warmCache: {
        height: 1,
        opacity: 0,
        overflow: 'hidden',
        width: 1,
    },
});
