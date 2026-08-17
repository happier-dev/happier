import * as React from 'react';
import { type LayoutChangeEvent, Platform, StyleSheet, View } from 'react-native';
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
import { Spotlight } from './Spotlight';
import type { StageFrame } from './stageFrames';
import {
    preloadStageSurfaces,
    resetStageSurfaceComponent,
    stageSurfaceById,
    type StageSurfaceId,
} from './stageSurfaces';
import {
    StageSurfaceSkeleton,
    StageSurfaceUnavailable,
} from './StageSurfaceFallbacks';
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
    useStageWebCamera,
} from './useStageWebCamera';

const WebInertAnimatedView = Animated.View as React.ComponentType<
    React.ComponentProps<typeof Animated.View>
    & Pick<React.HTMLAttributes<HTMLElement>, 'inert'>
>;

export const STAGE_SURFACE_MATERIALIZE_FADE_MS = reanimatedMotionTokens.durationMs.fast;

/**
 * How many upcoming beats are pre-MOUNTED. Mounting a warm surface renders a
 * complete real app screen, so only the beat the journey reaches next earns one;
 * everything further ahead is warmed as a module import instead (`preloadStageSurfaces`).
 */
const STAGE_WARM_MOUNT_LIMIT = 1;

const UPCOMING_SURFACE_KEY_SEPARATOR = '\u0000';

// The web camera drives a promoted CSS layer and never freezes; the native story
// layout mounts one DemoStage per beat, so a frozen frame could never be shown
// either. The stage therefore has no frozen layer for these hooks to drive.
function noopStageCameraCallback(): void {}

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
    /**
     * Frames the journey can reach from the active beat, nearest first. The HOST
     * owns beat order — the frame table's array order is not the journey's path,
     * so warming array neighbours warms surfaces the user never reaches. The
     * stage owns only the cost policy over that list: it pre-mounts the nearest
     * frame and preloads the remaining surface modules without mounting them.
     *
     * Ids the frame table does not contain, and ids whose surface the active
     * frame already owns, are skipped. Omitting the prop (or passing an empty
     * list) means the host has nothing to declare: the stage paints the active
     * beat alone and warms nothing. It never guesses.
     */
    upcomingFrameIds?: readonly string[];
    reducedMotion?: boolean;
}>;

type StageSize = Readonly<{
    width: number;
    height: number;
}>;

export function resolveMountedStageFrames(
    frames: readonly StageFrame[],
    activeFrameId: string,
    upcomingFrameIds: readonly string[] = [],
): readonly StageFrame[] {
    const activeFrame = resolveActiveFrame(frames, activeFrameId);
    if (!activeFrame) return [];
    const frameById = new Map(frames.map((frame) => [frame.id, frame]));
    const mountedSurfaces = new Set<StageSurfaceId>([activeFrame.surface]);
    const warmFrames: StageFrame[] = [];

    for (const frameId of upcomingFrameIds) {
        if (warmFrames.length >= STAGE_WARM_MOUNT_LIMIT) break;
        const frame = frameById.get(frameId);
        if (!frame || mountedSurfaces.has(frame.surface)) continue;
        mountedSurfaces.add(frame.surface);
        warmFrames.push(frame);
    }

    return [activeFrame, ...warmFrames];
}

/**
 * Surfaces the journey will need next that the active frame does not already
 * own. Mounted warm frames are included: `preloadStageSurfaces` returns the same
 * cached import, so the caller never has to know which upcoming frames the warm
 * cache happened to mount.
 */
function resolveUpcomingStageSurfaceIds(
    frames: readonly StageFrame[],
    upcomingFrameIds: readonly string[] | undefined,
    activeSurfaceId: StageSurfaceId,
): readonly StageSurfaceId[] {
    if (!upcomingFrameIds || upcomingFrameIds.length === 0) return [];
    const frameById = new Map(frames.map((frame) => [frame.id, frame]));
    const surfaceIds: StageSurfaceId[] = [];
    const seen = new Set<StageSurfaceId>([activeSurfaceId]);

    for (const frameId of upcomingFrameIds) {
        const frame = frameById.get(frameId);
        if (!frame || seen.has(frame.surface)) continue;
        seen.add(frame.surface);
        surfaceIds.push(frame.surface);
    }

    return surfaceIds;
}

function resolveActiveFrame(frames: readonly StageFrame[], activeFrameId: string): StageFrame | null {
    if (frames.length === 0) return null;
    return frames.find((frame) => frame.id === activeFrameId) ?? frames[0] ?? null;
}

/**
 * A lazily imported surface that rejects used to take the whole stage down: the
 * thrown chunk error escaped to the nearest boundary above the journey. It now
 * degrades to an honest in-frame state, and drops the poisoned lazy component so
 * returning to the beat re-attempts the import.
 */
class StageSurfaceErrorBoundary extends React.Component<
    React.PropsWithChildren<Readonly<{ fallback: React.ReactNode; onError: () => void }>>,
    Readonly<{ failed: boolean }>
> {
    state: Readonly<{ failed: boolean }> = { failed: false };

    static getDerivedStateFromError(): Readonly<{ failed: boolean }> {
        return { failed: true };
    }

    componentDidCatch(): void {
        this.props.onError();
    }

    render(): React.ReactNode {
        return this.state.failed ? this.props.fallback : this.props.children;
    }
}

function StageSurfaceSlot(props: Readonly<{
    frame: StageFrame;
    visible: boolean;
    spotlightTargetsActive?: boolean;
    style?: object;
    testID?: string;
    reducedMotion: boolean;
}>): React.ReactElement | null {
    const surfaceId = props.frame.surface;
    const surface = stageSurfaceById.get(surfaceId);
    const handleSurfaceError = React.useCallback(() => {
        resetStageSurfaceComponent(surfaceId);
    }, [surfaceId]);
    if (!surface) return null;
    const Surface = surface.component;
    const testID = props.testID ?? `demo-stage-frame-${props.frame.id}`;
    const content = (
        <SpotlightTargetScope active={props.spotlightTargetsActive === true}>
            <StageSurfaceErrorBoundary
                key={surfaceId}
                onError={handleSurfaceError}
                fallback={<StageSurfaceUnavailable testID={`${testID}-error`} />}
            >
                <React.Suspense fallback={(
                    <StageSurfaceSkeleton
                        device={props.frame.device}
                        testID={`${testID}-loading`}
                    />
                )}>
                    <MaterializedStageSurface
                        testID={`${testID}-content`}
                        reducedMotion={props.reducedMotion}
                    >
                        <Surface device={props.frame.device} />
                    </MaterializedStageSurface>
                </React.Suspense>
            </StageSurfaceErrorBoundary>
        </SpotlightTargetScope>
    );

    return (
        // DemoStage is a static guided visual. `visible` controls painting only:
        // active, outgoing, and warm slots must all remain outside interaction
        // and assistive-technology traversal while their real surfaces are mounted.
        <WebInertAnimatedView
            testID={testID}
            pointerEvents="none"
            inert={Platform.OS === 'web' ? true : undefined}
            aria-hidden={Platform.OS === 'web' ? true : undefined}
            accessibilityElementsHidden={Platform.OS === 'web' ? undefined : true}
            importantForAccessibility={Platform.OS === 'web' ? undefined : 'no-hide-descendants'}
            style={[
                styles.surfaceSlot,
                props.visible ? styles.activeSlot : styles.warmSlot,
                props.style,
            ]}
        >
            {content}
        </WebInertAnimatedView>
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
    });
    const [outgoingFrame, setOutgoingFrame] = React.useState<StageFrame | null>(null);
    const previousActiveFrameRef = React.useRef(props.activeFrame);
    const previousCameraFrameRef = React.useRef(props.activeFrame);
    const webCameraOuterRef = React.useRef<StageWebCameraNode | null>(null);
    const webCameraInnerRef = React.useRef<StageWebCameraNode | null>(null);
    const webHaloRef = React.useRef<StageWebHaloNode | null>(null);
    const webCameraEnabled = Platform.OS === 'web' && transform.mode === 'camera';

    useStageWebCamera({
        enabled: webCameraEnabled,
        frameId: props.activeFrame.id,
        target: transform.settledTransform,
        outerRef: webCameraOuterRef,
        innerRef: webCameraInnerRef,
        haloRef: webHaloRef,
        haloSourceRect: props.activeFrame.spotlight && spotlightTarget.found
            ? spotlightTarget.rect
            : null,
        transformBounds: cameraTransformBounds,
        cameraNodeTranslationScale: cameraViewport.scale > 0 ? 1 / cameraViewport.scale : 1,
        freezeDuringMotion: false,
        onMotionChange: noopStageCameraCallback,
        onSettled: noopStageCameraCallback,
    });

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
        previousCameraFrameRef.current = props.activeFrame;
        // A new frame re-aims the camera, so the previously settled halo rect is
        // stale until the next visual read lands.
        if (previousFrame.id !== props.activeFrame.id) setSettledSpotlightRect(null);
    }, [props.activeFrame]);

    React.useLayoutEffect(() => {
        if (
            Platform.OS === 'web'
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
        props.activeFrame.id,
        props.activeFrame.spotlight,
        readVisualSpotlightTargetRect,
        spotlightTarget.found,
        spotlightTarget.rect,
    ]);

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
                            reducedMotion={transform.mode === 'crossfade'}
                            style={transform.mode === 'crossfade' ? transform.incomingCrossfadeAnimatedStyle : undefined}
                        />
                    </Animated.View>
                </Animated.View>
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
    // Joining keeps the warm-up keyed by CONTENT: the host rebuilds the id array
    // every render, and re-firing the import on each of those is pure churn.
    const upcomingSurfaceKey = activeFrame
        ? resolveUpcomingStageSurfaceIds(props.frames, props.upcomingFrameIds, activeFrame.surface).join(UPCOMING_SURFACE_KEY_SEPARATOR)
        : '';
    const upcomingSurfaceIds = React.useMemo<readonly StageSurfaceId[]>(() => (
        upcomingSurfaceKey === ''
            ? []
            : upcomingSurfaceKey.split(UPCOMING_SURFACE_KEY_SEPARATOR) as StageSurfaceId[]
    ), [upcomingSurfaceKey]);

    React.useEffect(() => {
        if (upcomingSurfaceIds.length === 0) return;
        // Warming the module while the user reads the current beat is what removes
        // the cold-chunk wait at the next one; a failed warm-up is not fatal here
        // because the mount path has its own boundary.
        void preloadStageSurfaces(upcomingSurfaceIds).catch(() => undefined);
    }, [upcomingSurfaceIds]);

    if (!activeFrame) return null;
    const mountedFrames = resolveMountedStageFrames(props.frames, props.activeFrameId, props.upcomingFrameIds);

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
