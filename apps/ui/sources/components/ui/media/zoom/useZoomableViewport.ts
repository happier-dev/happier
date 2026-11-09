import * as React from 'react';
import { PixelRatio, Platform } from 'react-native';
import { Gesture, PointerType } from 'react-native-gesture-handler';
import { cancelAnimation, runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { resolveSessionSwitcherEdgeHitSlop } from '@/components/navigation/mobile/chrome/lateralSwipe/sessionSwitcherGesture';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import {
    clampPan, clampZoom, dismissPresentation, focalZoom, galleryDirection, panBounds, projectRelease,
    resizeZoom, resolveZoomBounds, rubberBandPan, rubberBandScale, shouldDismiss, wheelZoomFactor,
    type ZoomPoint, type ZoomSize, type ZoomState,
} from './zoomGeometry';
import type { WheelZoomHandlers } from './wheelZoom';

export type ZoomableViewportInput = Readonly<{
    /** Intrinsic dimensions of the loaded image, before its fit transform. */
    imageSize: ZoomSize;
    viewportSize: ZoomSize;
    devicePixelRatio?: number;
    reducedMotion?: boolean;
    hasPrevious?: boolean;
    hasNext?: boolean;
    /** The stage supplies theme.space.s24. Geometry itself owns no spacing token. */
    pageGap?: number;
    onDismiss?: (velocityY: number) => void;
    onPage?: (direction: -1 | 1, velocityX: number) => void;
    onTap?: () => void;
    onZoomSettled?: (aboveFit: boolean) => void;
    /** Off while one finger belongs to the picture's own tool (annotating): two fingers still pan and pinch. */
    onePointerPan?: boolean;
    /** Native composition binds hapticsLight; fired at most once per pinch. */
    onZoomBoundary?: () => void;
}>;

/** Renderless viewport owner. Chrome remains outside its GestureDetector in the stage composition. */
export function useZoomableViewport(input: ZoomableViewportInput) {
    const preferredReducedMotion = useReducedMotionPreference();
    const onePointerPan = input.onePointerPan ?? true;
    const initialDpr = input.devicePixelRatio ?? PixelRatio.get();
    const initialBounds = resolveZoomBounds(input.imageSize, input.viewportSize, initialDpr);
    const image = useSharedValue(input.imageSize);
    const viewport = useSharedValue(input.viewportSize);
    const dpr = useSharedValue(initialDpr);
    const reducedMotion = useSharedValue(input.reducedMotion ?? preferredReducedMotion);
    const scale = useSharedValue(initialBounds.min);
    const translationX = useSharedValue(0);
    const translationY = useSharedValue(0);
    const dismissX = useSharedValue(0);
    const dismissY = useSharedValue(0);
    const pageTranslation = useSharedValue(0);
    const panActive = useSharedValue(false);
    const pinchStarted = useSharedValue(false);
    const pinchActive = useSharedValue(false);
    const pinchStart = useSharedValue<ZoomState>({ scale: initialBounds.min, x: 0, y: 0 });
    const pinchFocal = useSharedValue<ZoomPoint>({ x: 0, y: 0 });
    const boundaryEmitted = useSharedValue(false);
    const panStart = useSharedValue<ZoomPoint>({ x: 0, y: 0 });
    // 0 undecided, 1 image pan, 2 gallery, 3 vertical dismiss.
    const panMode = useSharedValue(0);
    const paging = useSharedValue({ enabled: Boolean(input.onPage), previous: input.hasPrevious ?? true, next: input.hasNext ?? true, gap: input.pageGap ?? 0 });
    const dismissEnabled = useSharedValue(Boolean(input.onDismiss));
    const latest = React.useRef(input);
    latest.current = input;

    const publishSettled = React.useCallback((aboveFit: boolean) => latest.current.onZoomSettled?.(aboveFit), []);
    const publishDismiss = React.useCallback((velocityY: number) => latest.current.onDismiss?.(velocityY), []);
    const publishPage = React.useCallback((direction: -1 | 1, velocityX: number) => latest.current.onPage?.(direction, velocityX), []);
    const publishTap = React.useCallback(() => latest.current.onTap?.(), []);
    const publishBoundary = React.useCallback(() => latest.current.onZoomBoundary?.(), []);

    const syncDimensions = React.useCallback(() => {
        const next = latest.current;
        const previous = viewport.value;
        const nextDpr = next.devicePixelRatio ?? PixelRatio.get();
        if (previous.width === next.viewportSize.width && previous.height === next.viewportSize.height
            && image.value.width === next.imageSize.width && image.value.height === next.imageSize.height && dpr.value === nextDpr) return;
        if ((panActive.value || pinchStarted.value) && previous.width === next.viewportSize.width) return;
        const previousScale = image.value.width === 0 || image.value.height === 0 ? 0 : scale.value;
        const state = resizeZoom({ scale: previousScale, x: translationX.value, y: translationY.value }, next.imageSize, previous, next.viewportSize, nextDpr, false);
        image.value = next.imageSize;
        viewport.value = next.viewportSize;
        dpr.value = nextDpr;
        scale.value = state.scale;
        translationX.value = state.x;
        translationY.value = state.y;
    }, [dpr, image, panActive, pinchStarted, scale, translationX, translationY, viewport]);

    React.useEffect(syncDimensions, [input.imageSize.width, input.imageSize.height, input.viewportSize.width, input.viewportSize.height, input.devicePixelRatio, syncDimensions]);
    React.useEffect(() => {
        reducedMotion.value = input.reducedMotion ?? preferredReducedMotion;
        paging.value = { enabled: Boolean(input.onPage), previous: input.hasPrevious ?? true, next: input.hasNext ?? true, gap: input.pageGap ?? 0 };
        dismissEnabled.value = Boolean(input.onDismiss);
    }, [dismissEnabled, input.hasNext, input.hasPrevious, input.onDismiss, input.onPage, input.pageGap, input.reducedMotion, paging, preferredReducedMotion, reducedMotion]);

    const stopMotion = React.useCallback(() => {
        'worklet';
        cancelAnimation(scale);
        cancelAnimation(translationX);
        cancelAnimation(translationY);
        cancelAnimation(dismissX);
        cancelAnimation(dismissY);
        cancelAnimation(pageTranslation);
    }, [dismissX, dismissY, pageTranslation, scale, translationX, translationY]);

    const settle = React.useCallback((state: ZoomState, velocity: ZoomPoint = { x: 0, y: 0 }) => {
        'worklet';
        const bounds = resolveZoomBounds(image.value, viewport.value, dpr.value);
        const nextScale = clampZoom(state.scale, bounds.min, bounds.max);
        const nextPan = clampPan({ x: state.x, y: state.y }, panBounds(image.value, viewport.value, nextScale));
        const clamped = nextScale !== state.scale || nextPan.x !== state.x || nextPan.y !== state.y;
        const spring = { ...reanimatedMotionTokens.spring.travel, dampingRatio: clamped ? 0.82 : 1 };
        if (reducedMotion.value) {
            scale.value = nextScale;
            translationX.value = nextPan.x;
            translationY.value = nextPan.y;
            runOnJS(publishSettled)(nextScale > bounds.min);
            return;
        }
        translationX.value = withSpring(nextPan.x, { ...spring, velocity: velocity.x });
        translationY.value = withSpring(nextPan.y, { ...spring, velocity: velocity.y });
        scale.value = withSpring(nextScale, spring, (finished) => {
            'worklet';
            if (finished) runOnJS(publishSettled)(nextScale > bounds.min);
        });
    }, [dpr, image, publishSettled, reducedMotion, scale, translationX, translationY, viewport]);

    const zoomAt = React.useCallback((nextScale: number, focal: ZoomPoint = { x: 0, y: 0 }) => {
        'worklet';
        if (viewport.value.width === 0 || viewport.value.height === 0 || image.value.width === 0 || image.value.height === 0) return;
        stopMotion();
        const bounds = resolveZoomBounds(image.value, viewport.value, dpr.value);
        settle(focalZoom({ scale: scale.value, x: translationX.value, y: translationY.value }, clampZoom(nextScale, bounds.min, bounds.max), focal));
    }, [dpr, image, scale, settle, stopMotion, translationX, translationY, viewport]);
    const fit = React.useCallback(() => zoomAt(resolveZoomBounds(image.value, viewport.value, dpr.value).min), [dpr, image, viewport, zoomAt]);
    const actual = React.useCallback(() => zoomAt(resolveZoomBounds(image.value, viewport.value, dpr.value).natural), [dpr, image, viewport, zoomAt]);
    const zoomIn = React.useCallback(() => zoomAt(scale.value * wheelZoomFactor(-100)), [scale, zoomAt]);
    const zoomOut = React.useCallback(() => zoomAt(scale.value * wheelZoomFactor(100)), [scale, zoomAt]);

    const gesture = React.useMemo(() => {
        const pinch = Gesture.Pinch().withTestId('media-pinch')
            .onStart((event) => {
                if (event.numberOfPointers !== 2) return;
                stopMotion();
                pinchStarted.value = true;
                pinchActive.value = true;
                boundaryEmitted.value = false;
                pinchStart.value = { scale: scale.value, x: translationX.value, y: translationY.value };
                pinchFocal.value = { x: event.focalX - viewport.value.width / 2, y: event.focalY - viewport.value.height / 2 };
            })
            .onTouchesUp(() => { pinchActive.value = false; })
            .onUpdate((event) => {
                if (!pinchActive.value || event.numberOfPointers !== 2) return;
                const bounds = resolveZoomBounds(image.value, viewport.value, dpr.value);
                const rawScale = pinchStart.value.scale * event.scale;
                const nextScale = reducedMotion.value ? clampZoom(rawScale, bounds.min, bounds.max) : rubberBandScale(rawScale, bounds);
                const next = focalZoom(pinchStart.value, nextScale, pinchFocal.value, { x: event.focalX - viewport.value.width / 2, y: event.focalY - viewport.value.height / 2 });
                scale.value = next.scale;
                translationX.value = next.x;
                translationY.value = next.y;
                if (!boundaryEmitted.value && (rawScale <= bounds.min || rawScale >= bounds.max)) {
                    boundaryEmitted.value = true;
                    if (Platform.OS !== 'web') runOnJS(publishBoundary)();
                }
            })
            .onEnd(() => {
                pinchActive.value = false;
                settle({ scale: scale.value, x: translationX.value, y: translationY.value });
            })
            .onFinalize((_event, success) => {
                pinchActive.value = false;
                if (pinchStarted.value && success === false) settle({ scale: scale.value, x: translationX.value, y: translationY.value });
                pinchStarted.value = false;
                runOnJS(syncDimensions)();
            });

        const pan = Gesture.Pan().withTestId('media-pan').enabled(onePointerPan).minPointers(1).maxPointers(1)
            .minDistance(motionTokens.gesture.slopPx).enableTrackpadTwoFingerGesture(false)
            .hitSlop(Platform.OS === 'web' ? {} : resolveSessionSwitcherEdgeHitSlop(Platform.OS))
            .onStart(() => {
                stopMotion();
                panActive.value = true;
                panStart.value = { x: translationX.value, y: translationY.value };
                panMode.value = 0;
            })
            .onUpdate((event) => {
                if (pinchActive.value || event.numberOfPointers > 1) return;
                const bounds = resolveZoomBounds(image.value, viewport.value, dpr.value);
                const panLimits = panBounds(image.value, viewport.value, scale.value);
                if (panMode.value === 0) {
                    if (Math.abs(event.translationX) === Math.abs(event.translationY)) return;
                    const horizontal = Math.abs(event.translationX) > Math.abs(event.translationY);
                    const atEdge = event.translationX < 0 ? panStart.value.x <= -panLimits.x : panStart.value.x >= panLimits.x;
                    panMode.value = !horizontal && scale.value <= bounds.min && dismissEnabled.value ? 3
                        : horizontal && paging.value.enabled && atEdge ? 2 : 1;
                }
                if (panMode.value === 3) {
                    dismissX.value = event.translationX;
                    dismissY.value = event.translationY;
                } else if (panMode.value === 2) {
                    const available = event.translationX < 0 ? paging.value.next : paging.value.previous;
                    pageTranslation.value = available ? event.translationX : reducedMotion.value ? 0 : rubberBandPan(event.translationX, 0, viewport.value.width);
                } else {
                    const x = panStart.value.x + event.translationX;
                    const y = panStart.value.y + event.translationY;
                    translationX.value = reducedMotion.value ? clampZoom(x, -panLimits.x, panLimits.x) : rubberBandPan(x, panLimits.x, viewport.value.width);
                    translationY.value = reducedMotion.value ? clampZoom(y, -panLimits.y, panLimits.y) : rubberBandPan(y, panLimits.y, viewport.value.height);
                }
            })
            .onEnd((event) => {
                const velocity = { x: event.velocityX, y: event.velocityY };
                if (panMode.value === 3) {
                    if (shouldDismiss({ x: event.translationX, y: event.translationY }, velocity, viewport.value.height)) {
                        runOnJS(publishDismiss)(event.velocityY);
                        return;
                    }
                    dismissX.value = reducedMotion.value ? 0 : withSpring(0, { ...reanimatedMotionTokens.spring.travel, velocity: event.velocityX });
                    dismissY.value = reducedMotion.value ? 0 : withSpring(0, { ...reanimatedMotionTokens.spring.travel, velocity: event.velocityY });
                } else if (panMode.value === 2) {
                    const direction = galleryDirection(event.translationX, event.velocityX, viewport.value.width);
                    const available = direction === 1 ? paging.value.next : paging.value.previous;
                    if (direction !== 0 && available) {
                        if (reducedMotion.value) {
                            pageTranslation.value = 0;
                            runOnJS(publishPage)(direction, event.velocityX);
                        } else {
                            pageTranslation.value = withSpring(-direction * (viewport.value.width + paging.value.gap), { ...reanimatedMotionTokens.spring.travel, velocity: event.velocityX }, (finished) => {
                                'worklet';
                                if (finished) runOnJS(publishPage)(direction, event.velocityX);
                            });
                        }
                    } else {
                        pageTranslation.value = reducedMotion.value ? 0 : withSpring(0, { ...reanimatedMotionTokens.spring.travel, velocity: event.velocityX });
                    }
                } else {
                    settle({ scale: scale.value, x: projectRelease(translationX.value, event.velocityX), y: projectRelease(translationY.value, event.velocityY) }, velocity);
                }
            })
            .onFinalize((_event, success) => {
                if (panActive.value && success === false) {
                    dismissX.value = reducedMotion.value ? 0 : withSpring(0, reanimatedMotionTokens.spring.travel);
                    dismissY.value = reducedMotion.value ? 0 : withSpring(0, reanimatedMotionTokens.spring.travel);
                    pageTranslation.value = reducedMotion.value ? 0 : withSpring(0, reanimatedMotionTokens.spring.travel);
                    if (!pinchActive.value) settle({ scale: scale.value, x: translationX.value, y: translationY.value });
                }
                panActive.value = false;
                runOnJS(syncDimensions)();
            });

        const doubleTap = Gesture.Tap().withTestId('media-double-tap').numberOfTaps(2)
            .maxDelay(motionTokens.gesture.doubleTapMs).maxDistance(motionTokens.gesture.slopPx)
            .onEnd((event, success) => {
                if (!success) return;
                const bounds = resolveZoomBounds(image.value, viewport.value, dpr.value);
                zoomAt(scale.value > bounds.min ? bounds.min : bounds.doubleTap, { x: event.x - viewport.value.width / 2, y: event.y - viewport.value.height / 2 });
            });
        const tap = Gesture.Tap().withTestId('media-tap').maxDistance(motionTokens.gesture.slopPx)
            .onEnd((event, success) => {
                if (!success) return;
                const focal = { x: event.x - viewport.value.width / 2, y: event.y - viewport.value.height / 2 };
                const outside = Math.abs(focal.x - translationX.value) > image.value.width * scale.value / 2
                    || Math.abs(focal.y - translationY.value) > image.value.height * scale.value / 2;
                if (outside && dismissEnabled.value) runOnJS(publishDismiss)(0);
                else if (Platform.OS === 'web' && event.pointerType === PointerType.MOUSE) {
                    const bounds = resolveZoomBounds(image.value, viewport.value, dpr.value);
                    zoomAt(scale.value > bounds.min ? bounds.min : bounds.natural, focal);
                } else runOnJS(publishTap)();
            });
        return Gesture.Race(Gesture.Simultaneous(pinch, pan), Gesture.Exclusive(doubleTap, tap));
    }, [boundaryEmitted, onePointerPan, dismissEnabled, dismissX, dismissY, dpr, image, pageTranslation, paging, panActive, panMode, panStart, pinchActive, pinchFocal, pinchStart, pinchStarted, publishBoundary, publishDismiss, publishPage, publishTap, reducedMotion, scale, settle, stopMotion, syncDimensions, translationX, translationY, viewport, zoomAt]);

    const contentStyle = useAnimatedStyle(() => {
        const fitScale = resolveZoomBounds(image.value, viewport.value, dpr.value).min;
        return { width: image.value.width * fitScale, height: image.value.height * fitScale, transform: [{ translateX: translationX.value }, { translateY: translationY.value }, { scale: fitScale === 0 ? 1 : scale.value / fitScale }] };
    });
    const dismissStyle = useAnimatedStyle(() => ({ transform: [{ translateX: dismissX.value }, { translateY: dismissY.value }, { scale: reducedMotion.value ? 1 : dismissPresentation(dismissY.value, viewport.value.height).scale }] }));
    const backdropStyle = useAnimatedStyle(() => ({ opacity: dismissPresentation(dismissY.value, viewport.value.height).backdrop }));
    const pageStyle = useAnimatedStyle(() => ({ transform: [{ translateX: pageTranslation.value }] }));
    const wheelHandlers = React.useMemo<WheelZoomHandlers>(() => ({
        isZoomed: () => scale.value > resolveZoomBounds(image.value, viewport.value, dpr.value).min,
        onZoom: (factor, focal) => {
            stopMotion();
            const bounds = resolveZoomBounds(image.value, viewport.value, dpr.value);
            const next = focalZoom({ scale: scale.value, x: translationX.value, y: translationY.value }, clampZoom(scale.value * factor, bounds.min, bounds.max), focal);
            const point = clampPan(next, panBounds(image.value, viewport.value, next.scale));
            scale.value = next.scale;
            translationX.value = point.x;
            translationY.value = point.y;
            publishSettled(next.scale > bounds.min);
        },
        onPan: (delta) => {
            stopMotion();
            const point = clampPan({ x: translationX.value + delta.x, y: translationY.value + delta.y }, panBounds(image.value, viewport.value, scale.value));
            translationX.value = point.x;
            translationY.value = point.y;
        },
    }), [dpr, image, publishSettled, scale, stopMotion, translationX, translationY, viewport]);

    return { gesture, scale, translationX, translationY, dismissX, dismissY, pageTranslation, contentStyle, dismissStyle, backdropStyle, pageStyle, wheelHandlers, fit, actual, zoomIn, zoomOut, zoomAt };
}
