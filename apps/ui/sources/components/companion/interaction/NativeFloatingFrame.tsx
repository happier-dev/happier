import * as React from 'react';
import { View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, { measure, useAnimatedRef, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import {
    HAPPIER_FLOATING_FRAME_METRICS,
    resolveFloatingFrameRect,
    resolveFloatingFrameResizeRect,
    type HappierFloatingFrameNativeBindingProps,
} from '@happier-dev/plugin-ui/presentation';

import { RetainedPresentationNativeMotionContext, usePublishRetainedPresentationNativeMotion } from '@/components/ui/presentation/retainedPresentationSlots';
import { useCompanionNoDragRegions } from './CompanionNoDragRegion';
import { useCompanionNativePanGesture } from './useCompanionNativePanGesture';

/** Native dependency/measurement adapter. All pan and spring state stays in the companion owner. */
export function NativeFloatingFrame(props: HappierFloatingFrameNativeBindingProps): React.ReactElement {
    const nativeRef = useAnimatedRef<View>();
    const noDragRegions = useCompanionNoDragRegions();
    const { rect, availableRect, aspectRatio, chromeHeight, minWidth, bodyRect, moveInput } = props;
    const enabled = props.mode === 'floating';
    const width = useSharedValue(rect.width);
    const height = useSharedValue(rect.height);
    const resizeRight = useSharedValue(rect.x + rect.width);
    const resizeY = useSharedValue(rect.y);
    const [portalActive, setPortalActive] = React.useState(false);
    React.useEffect(() => {
        width.value = rect.width;
        height.value = rect.height;
    }, [rect.width, rect.height, props.mode, moveInput, width, height]);
    const bounds = React.useMemo(() => ({
        minX: availableRect.x, maxX: Math.max(availableRect.x, availableRect.x + availableRect.width - rect.width),
        minY: availableRect.y, maxY: Math.max(availableRect.y, availableRect.y + availableRect.height - rect.height),
    }), [availableRect, rect.width, rect.height]);
    const pan = useCompanionNativePanGesture({
        enabled,
        admissionKey: moveInput,
        bounds,
        initialPoint: { x: rect.x, y: rect.y },
        noDragRegions,
        // Registered buttons and the resize grip keep their own input. Admission uses the transformed frame's actual
        // window position, rather than the settled rect or a stale onLayout screen measurement.
        canStartAt: (point) => {
            'worklet';
            const measured = measure(nativeRef);
            if (!measured) return false;
            const x = point.x - measured.pageX;
            const y = point.y - measured.pageY;
            const bodyTop = bodyRect.y - rect.y;
            const bodyBottom = bodyTop + height.value - chromeHeight;
            const grip = HAPPIER_FLOATING_FRAME_METRICS.gripSize * 2;
            if (x < 0 || x > width.value || y < 0 || y > height.value) return false;
            if (x <= grip && y >= bodyBottom - grip && y <= bodyBottom) return false;
            return moveInput === 'surface' || y < bodyTop || y > bodyBottom;
        },
        releaseMotion: props.releaseMotion,
        motionPolicy: props.reducedMotion ? 'snap' : 'animate',
        positionPublication: 'release',
        resolveReleaseTarget: ({ released, projected }) => {
            'worklet';
            const placement = resolveFloatingFrameRect({
                rect: { ...released, width: width.value, height: height.value }, availableRect,
                aspectRatio, chromeHeight, minWidth, projectedPoint: projected,
            });
            return placement.fits ? { x: placement.rect.x, y: placement.rect.y } : released;
        },
        onDragRelease: ({ target }) => {
            const placement = resolveFloatingFrameRect({
                rect: { ...target, width: width.value, height: height.value }, availableRect, aspectRatio, chromeHeight, minWidth,
            });
            if (placement.fits) props.onRectChange(placement.rect, { kind: 'settle' });
        },
    });
    const { translateX, translateY, settleToPoint } = pan;
    // Movement and resize are two bindings over the same companion pan/lifecycle owner, just as
    // web uses two companion pointer sessions. Resize never projects a throw or publishes frames.
    const resize = useCompanionNativePanGesture({
        enabled, admissionKey: `${moveInput}:${rect.x}:${rect.y}`,
        initialPoint: { x: rect.width, y: 0 },
        bounds: { minX: 0, maxX: availableRect.width, minY: 0, maxY: 0 },
        noDragRegions: [],
        canStartAt: () => {
            'worklet';
            resizeRight.value = translateX.value + width.value;
            resizeY.value = translateY.value;
            return true;
        },
        resolveDragPoint: ({ start, translation }) => {
            'worklet';
            const next = resolveFloatingFrameResizeRect({
                rect: { x: resizeRight.value - start.x, y: resizeY.value, width: start.x, height: height.value },
                availableRect, aspectRatio, chromeHeight,
                minWidth: Math.max(HAPPIER_FLOATING_FRAME_METRICS.gripSize * 2, minWidth ?? 0),
                translationX: translation.x,
            });
            width.value = next.width;
            height.value = next.height;
            translateX.value = next.x;
            translateY.value = next.y;
            return { x: next.width, y: 0 };
        },
        releaseMotion: props.releaseMotion,
        motionPolicy: 'snap', positionPublication: 'release',
        onDragRelease: () => {
            const placement = resolveFloatingFrameRect({
                rect: { x: translateX.value, y: translateY.value, width: width.value, height: height.value },
                availableRect, aspectRatio, chromeHeight, minWidth,
            });
            if (!placement.fits) return;
            width.value = placement.rect.width;
            height.value = placement.rect.height;
            settleToPoint(placement.rect);
            props.onRectChange(placement.rect, { kind: 'settle' });
        },
    });
    const overlay = enabled && props.grip ? <GestureDetector gesture={resize.gesture}>{props.grip}</GestureDetector> : null;
    const sizeStyle = useAnimatedStyle(() => ({ width: width.value, height: height.value }));
    const localGripStyle = useAnimatedStyle(() => ({
        position: 'absolute', left: 0, top: bodyRect.y - rect.y,
        width: width.value, height: Math.max(0, height.value - chromeHeight),
    }));
    const motion = React.useMemo(() => ({
        x: translateX, y: translateY, anchorX: rect.x, anchorY: rect.y,
        width, height, chromeHeight, overlay: portalActive ? overlay : null, onPortalActiveChange: setPortalActive,
    }), [translateX, translateY, rect.x, rect.y, width, height, chromeHeight, overlay, portalActive]);
    const presentedMotion = props.mode === 'docked' ? null : motion;
    // A body bound in another tree (the frame drawn in the app's floating layer) moves on it too.
    usePublishRetainedPresentationNativeMotion(presentedMotion);

    return <RetainedPresentationNativeMotionContext.Provider value={presentedMotion}>
        <GestureDetector gesture={pan.gesture}>
            <Animated.View ref={nativeRef} collapsable={false} style={props.mode === 'docked' ? undefined : [
                { position: 'absolute', left: 0, top: 0 }, sizeStyle, pan.animatedStyle,
            ]}>
                {props.children}
                {!portalActive && overlay ? <Animated.View style={localGripStyle} pointerEvents="box-none">{overlay}</Animated.View> : null}
            </Animated.View>
        </GestureDetector>
    </RetainedPresentationNativeMotionContext.Provider>;
}
